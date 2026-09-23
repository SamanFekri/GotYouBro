import { and, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { AppConfig } from '../config/index.js';
import type { Db } from '../database/client.js';
import {
  apiCredentials,
  destinations,
  services,
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
import type { HealthService } from './health.service.js';

export interface ServiceInput {
  name?: string;
  description?: string | null;
  destinationId?: string | null;
  apiEnabled?: boolean;
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

export function toServiceView(
  service: Service,
  destination: Pick<Destination, 'id' | 'name' | 'type' | 'verified'> | null | undefined,
  credential: Pick<ApiCredential, 'tokenPrefix' | 'createdAt' | 'lastUsedAt'> | null | undefined,
) {
  const { userId: _userId, ...rest } = service;
  return {
    ...rest,
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
    private readonly health: HealthService,
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

  create(user: User, input: ServiceInput & { name: string }): { service: Service; token: string } {
    const limits = this.limits.forUser(user);
    if (this.countForUser(user.id) >= limits.maxServices) {
      throw new AppError('LIMIT_EXCEEDED', `You can create at most ${limits.maxServices} services`);
    }
    const rate = this.limiter.consume([this.limits.serviceCreateCheck(user)]);
    if (!rate.allowed) throw new AppError('RATE_LIMITED', 'Too many services created recently, try again later');
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
        healthEnabled: input.healthEnabled ?? false,
        healthNotify: input.healthNotify ?? true,
        healthIntervalSeconds: input.healthIntervalSeconds ?? this.config.defaults.heartbeatIntervalSeconds,
        healthGraceSeconds: input.healthGraceSeconds ?? this.config.defaults.heartbeatGraceSeconds,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
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
    const monitoringBefore = current.healthEnabled && current.status === 'ACTIVE';
    const nextHealthEnabled = input.healthEnabled ?? current.healthEnabled;
    const nextStatus = input.status ?? current.status;
    const monitoringAfter = nextHealthEnabled && nextStatus === 'ACTIVE';

    const updated = this.db
      .update(services)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.destinationId !== undefined && { destinationId: input.destinationId }),
        ...(input.apiEnabled !== undefined && { apiEnabled: input.apiEnabled }),
        ...(input.healthEnabled !== undefined && { healthEnabled: input.healthEnabled }),
        ...(input.healthNotify !== undefined && { healthNotify: input.healthNotify }),
        ...(input.healthIntervalSeconds !== undefined && { healthIntervalSeconds: input.healthIntervalSeconds }),
        ...(input.healthGraceSeconds !== undefined && { healthGraceSeconds: input.healthGraceSeconds }),
        ...(input.status !== undefined && { status: input.status }),
      })
      .where(eq(services.id, current.id))
      .returning()
      .get();

    // Starting or stopping monitoring resets health state so stale heartbeats don't trigger alerts.
    if (monitoringBefore !== monitoringAfter) return this.health.resetMonitoring(updated.id);
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
    return rows.map((s) => toServiceView(s, s.destinationId ? destBy.get(s.destinationId) : null, credBy.get(s.id)));
  }
}
