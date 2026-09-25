import { and, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { AppConfig } from '../config/index.js';
import type { Db } from '../database/client.js';
import {
  apiCredentials,
  destinations,
  services,
  type Monitor,
  users,
  type ApiCredential,
  type Destination,
  type Service,
  type ServiceStatus,
  type User,
} from '../database/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { LimitsService } from '../rate-limit/limits.js';
import type { RateLimiter } from '../rate-limit/rate-limit.js';
import type { CredentialsService } from './credentials.service.js';
import type { DestinationsService } from './destinations.service.js';
import { DEFAULT_MONITOR_KEY } from './health.service.js';
import { aggregateHealth, type MonitorsService } from './monitors.service.js';
import { isAdminUser } from './users.service.js';

export interface ServiceInput {
  name?: string;
  description?: string | null;
  destinationId?: string | null;
  apiEnabled?: boolean;
}

/** Creation-only convenience: also create the service's "default" health monitor. */
export interface ServiceCreateInput extends ServiceInput {
  name: string;
  healthEnabled?: boolean;
  healthNotify?: boolean;
  healthIntervalSeconds?: number;
  healthGraceSeconds?: number;
}

export interface ServiceLimitOverrides {
  maxBackupSizeMb?: number | null;
  apiRateLimit?: string | null;
  backupRateLimit?: string | null;
  heartbeatRateLimit?: string | null;
}

export type ServiceView = ReturnType<typeof toServiceView>;

export function toMonitorView(m: Monitor) {
  const { serviceId: _serviceId, ...rest } = m;
  return rest;
}

export function toServiceView(
  service: Service,
  destination: Pick<Destination, 'id' | 'name' | 'type' | 'verified'> | null | undefined,
  credential: Pick<ApiCredential, 'tokenPrefix' | 'createdAt' | 'lastUsedAt'> | null | undefined,
  serviceMonitors: Monitor[],
) {
  const { userId: _userId, ...rest } = service;
  const beats = serviceMonitors.map((m) => m.lastHeartbeatAt?.getTime() ?? 0).filter(Boolean);
  const primary = serviceMonitors.find((m) => m.key === DEFAULT_MONITOR_KEY) ?? serviceMonitors[0];
  return {
    ...rest,
    monitors: serviceMonitors.map(toMonitorView),
    // Service-level health, kept for backward compatibility with the pre-monitor API:
    // aggregated over enabled monitors (worst state wins); interval/grace/notify from the default monitor.
    healthEnabled: serviceMonitors.some((m) => m.enabled),
    healthStatus: aggregateHealth(serviceMonitors) ?? 'UNKNOWN',
    healthNotify: primary?.notify ?? true,
    healthIntervalSeconds: primary?.intervalSeconds ?? null,
    healthGraceSeconds: primary?.graceSeconds ?? null,
    lastHeartbeatAt: beats.length ? new Date(Math.max(...beats)) : null,
    wentDownAt: serviceMonitors.filter((m) => m.wentDownAt).map((m) => m.wentDownAt!).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
    lastRecoveredAt: primary?.lastRecoveredAt ?? null,
    totalDowntimeSeconds: serviceMonitors.reduce((sum, m) => sum + m.totalDowntimeSeconds, 0),
    downCount: serviceMonitors.reduce((sum, m) => sum + m.downCount, 0),
    destination: destination ? { id: destination.id, name: destination.name, type: destination.type, verified: destination.verified } : null,
    token: credential ? { prefix: credential.tokenPrefix, createdAt: credential.createdAt, lastUsedAt: credential.lastUsedAt } : null,
  };
}

export class ServicesService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly limits: LimitsService,
    private readonly limiter: RateLimiter,
    private readonly credentials: CredentialsService,
    private readonly destinationsService: DestinationsService,
    private readonly monitorsService: MonitorsService,
  ) {}

  /** Ownership-scoped lookup. Returns SERVICE_NOT_FOUND for other users' services (no existence leak). */
  getOwned(userId: string, id: string): Service {
    const service = this.db
      .select()
      .from(services)
      .where(and(eq(services.id, id), eq(services.userId, userId)))
      .get();
    if (!service) throw notFound('SERVICE_NOT_FOUND', 'Service');
    return service;
  }

  get(id: string): Service {
    const service = this.db.select().from(services).where(eq(services.id, id)).get();
    if (!service) throw notFound('SERVICE_NOT_FOUND', 'Service');
    return service;
  }

  listForUser(userId: string): ServiceView[] {
    const rows = this.db.select().from(services).where(eq(services.userId, userId)).orderBy(services.createdAt).all();
    return this.decorate(rows);
  }

  view(service: Service): ServiceView {
    return this.decorate([service])[0]!;
  }

  countForUser(userId: string): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(services).where(eq(services.userId, userId)).get()?.n ?? 0;
  }

  create(user: User, input: ServiceCreateInput): { service: Service; token: string } {
    // Administrators are not limited in how many services they create.
    if (!isAdminUser(user, this.config)) {
      const limits = this.limits.forUser(user);
      if (this.countForUser(user.id) >= limits.maxServices) {
        throw new AppError('LIMIT_EXCEEDED', `You can create at most ${limits.maxServices} services`);
      }
      const rate = this.limiter.consume([this.limits.serviceCreateCheck(user)]);
      if (!rate.allowed) throw new AppError('RATE_LIMITED', 'Too many services created recently, try again later');
    }
    if (input.destinationId) this.destinationsService.getOwned(user.id, input.destinationId);

    const now = new Date();
    const service = this.db
      .insert(services)
      .values({
        id: newId(),
        userId: user.id,
        name: input.name,
        description: input.description ?? null,
        destinationId: input.destinationId ?? null,
        apiEnabled: input.apiEnabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (input.healthEnabled) {
      this.monitorsService.create(user, service, {
        name: 'Default',
        key: DEFAULT_MONITOR_KEY,
        notify: input.healthNotify,
        intervalSeconds: input.healthIntervalSeconds,
        graceSeconds: input.healthGraceSeconds,
      });
    }
    const { token } = this.credentials.issue(service.id);
    return { service, token };
  }

  update(user: User, id: string, input: ServiceInput & { status?: Extract<ServiceStatus, 'ACTIVE' | 'DISABLED'> }): Service {
    const current = this.getOwned(user.id, id);
    if (input.destinationId) this.destinationsService.getOwned(user.id, input.destinationId);
    if (input.status && current.status === 'SUSPENDED') {
      throw new AppError('FORBIDDEN', 'This service was suspended by an administrator');
    }
    return this.applyUpdate(current, input);
  }

  delete(user: User, id: string): Service {
    const service = this.getOwned(user.id, id);
    this.db.delete(services).where(eq(services.id, service.id)).run();
    return service;
  }

  // ---- Admin ----

  adminSetStatus(id: string, status: ServiceStatus): Service {
    return this.applyUpdate(this.get(id), { status });
  }

  adminSetLimits(id: string, overrides: ServiceLimitOverrides): Service {
    this.get(id);
    return this.db.update(services).set(overrides).where(eq(services.id, id)).returning().get();
  }

  adminList(opts: { q?: string; userId?: string; status?: ServiceStatus; limit: number; offset: number }) {
    const conditions: SQL[] = [];
    if (opts.q) {
      const q = `%${opts.q}%`;
      conditions.push(or(like(services.name, q), eq(services.id, opts.q), like(users.username, q))!);
    }
    if (opts.userId) conditions.push(eq(services.userId, opts.userId));
    if (opts.status) conditions.push(eq(services.status, opts.status));
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = this.db
      .select({ service: services, owner: { id: users.id, telegramId: users.telegramId, username: users.username, blocked: users.blocked } })
      .from(services)
      .innerJoin(users, eq(users.id, services.userId))
      .where(where)
      .orderBy(desc(services.createdAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .all();
    const total =
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(services)
        .innerJoin(users, eq(users.id, services.userId))
        .where(where)
        .get()?.n ?? 0;
    const views = this.decorate(rows.map((r) => r.service));
    return { items: views.map((v, i) => ({ ...v, owner: rows[i]!.owner })), total };
  }

  private applyUpdate(current: Service, input: ServiceInput & { status?: ServiceStatus }): Service {
    const activeBefore = current.status === 'ACTIVE';
    const activeAfter = (input.status ?? current.status) === 'ACTIVE';

    const changes = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.destinationId !== undefined && { destinationId: input.destinationId }),
      ...(input.apiEnabled !== undefined && { apiEnabled: input.apiEnabled }),
      ...(input.status !== undefined && { status: input.status }),
    };
    if (!Object.keys(changes).length) return current; // e.g. a PATCH that only touches monitors
    const updated = this.db.update(services).set(changes).where(eq(services.id, current.id)).returning().get();

    // Disabling, suspending or re-enabling a service restarts its monitors so stale heartbeats
    // don't trigger alerts; the gap is recorded as "no data".
    if (activeBefore !== activeAfter) this.monitorsService.resetForService(updated.id);
    return updated;
  }

  private decorate(rows: Service[]): ServiceView[] {
    if (!rows.length) return [];
    const ids = rows.map((s) => s.id);
    const destIds = [...new Set(rows.map((s) => s.destinationId).filter((d): d is string => !!d))];
    const creds = this.db
      .select()
      .from(apiCredentials)
      .where(and(inArray(apiCredentials.serviceId, ids), isNull(apiCredentials.revokedAt)))
      .all();
    const dests = destIds.length ? this.db.select().from(destinations).where(inArray(destinations.id, destIds)).all() : [];
    const credBy = new Map(creds.map((c) => [c.serviceId, c]));
    const destBy = new Map(dests.map((d) => [d.id, d]));
    const monitorsBy = new Map<string, Monitor[]>();
    for (const m of this.monitorsService.listForServices(ids)) monitorsBy.set(m.serviceId, [...(monitorsBy.get(m.serviceId) ?? []), m]);
    return rows.map((s) =>
      toServiceView(s, s.destinationId ? destBy.get(s.destinationId) : null, credBy.get(s.id), monitorsBy.get(s.id) ?? []),
    );
  }
}
