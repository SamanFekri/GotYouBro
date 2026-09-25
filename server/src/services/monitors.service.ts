import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AppConfig } from '../config/index.js';
import type { Db } from '../database/client.js';
import { monitors, services, type Monitor, type Service, type User } from '../database/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { SettingsService } from './settings.service.js';
import { DEFAULT_MONITOR_KEY, type HealthService } from './health.service.js';
import { isAdminUser } from './users.service.js';

export const MONITOR_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DEFAULT_KEY = DEFAULT_MONITOR_KEY;

export interface MonitorInput {
  name?: string;
  key?: string;
  enabled?: boolean;
  notify?: boolean;
  intervalSeconds?: number;
  graceSeconds?: number;
}

/** Turn a label into a URL-safe monitor key ("Nightly Job" → "nightly-job"). */
export function slugifyKey(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'monitor';
}

export class MonitorsService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly settings: SettingsService,
    private readonly health: HealthService,
  ) {}

  listForServices(serviceIds: string[]): Monitor[] {
    if (!serviceIds.length) return [];
    return this.db.select().from(monitors).where(inArray(monitors.serviceId, serviceIds)).orderBy(asc(monitors.createdAt)).all();
  }

  listForService(serviceId: string): Monitor[] {
    return this.listForServices([serviceId]);
  }

  /** Ownership-scoped lookup through the service. MONITOR_NOT_FOUND for other users' monitors. */
  getOwned(userId: string, id: string): { monitor: Monitor; service: Service } {
    const row = this.db
      .select({ monitor: monitors, service: services })
      .from(monitors)
      .innerJoin(services, eq(services.id, monitors.serviceId))
      .where(and(eq(monitors.id, id), eq(services.userId, userId)))
      .get();
    if (!row) throw notFound('MONITOR_NOT_FOUND', 'Monitor');
    return row;
  }

  create(user: User, service: Service, input: MonitorInput & { name: string }): Monitor {
    if (!isAdminUser(user, this.config)) {
      const max = this.settings.getDefaultLimits().maxMonitorsPerService;
      const count = this.db.select({ n: sql<number>`count(*)` }).from(monitors).where(eq(monitors.serviceId, service.id)).get()?.n ?? 0;
      if (count >= max) throw new AppError('LIMIT_EXCEEDED', `A service can have at most ${max} monitors`);
    }
    const key = input.key ?? this.uniqueKey(service.id, slugifyKey(input.name));
    if (!MONITOR_KEY_PATTERN.test(key)) {
      throw new AppError('VALIDATION_ERROR', 'Monitor key: 1-40 lowercase letters, digits, "-" or "_", starting with a letter or digit');
    }
    if (this.findByKey(service.id, key)) throw new AppError('CONFLICT', `This service already has a monitor with key "${key}"`);

    const now = new Date();
    const monitor = this.db
      .insert(monitors)
      .values({
        id: newId(),
        serviceId: service.id,
        key,
        name: input.name,
        enabled: input.enabled ?? true,
        notify: input.notify ?? true,
        intervalSeconds: input.intervalSeconds ?? this.config.defaults.heartbeatIntervalSeconds,
        graceSeconds: input.graceSeconds ?? this.config.defaults.heartbeatGraceSeconds,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    this.health.startHistory(monitor);
    return monitor;
  }

  update(userId: string, id: string, input: Omit<MonitorInput, 'key'>): Monitor {
    const { monitor } = this.getOwned(userId, id);
    const updated = this.db
      .update(monitors)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.notify !== undefined && { notify: input.notify }),
        ...(input.intervalSeconds !== undefined && { intervalSeconds: input.intervalSeconds }),
        ...(input.graceSeconds !== undefined && { graceSeconds: input.graceSeconds }),
      })
      .where(eq(monitors.id, id))
      .returning()
      .get();
    // Switching a monitor on or off resets its state so stale heartbeats don't trigger alerts.
    if (input.enabled !== undefined && input.enabled !== monitor.enabled) return this.health.resetMonitoring(id);
    return updated;
  }

  delete(userId: string, id: string): Monitor {
    const { monitor } = this.getOwned(userId, id);
    this.db.delete(monitors).where(eq(monitors.id, id)).run(); // health_events cascade
    return monitor;
  }

  /**
   * Backward compatibility: the pre-monitor API configured health on the service itself. Apply
   * those settings to the service's "default" monitor, creating it when monitoring is switched on.
   */
  configureDefault(user: User, service: Service, input: Omit<MonitorInput, 'key' | 'name'>): Monitor | undefined {
    const existing = this.findByKey(service.id, DEFAULT_KEY);
    if (!existing) {
      if (!input.enabled) return undefined;
      return this.create(user, service, { ...input, name: 'Default', key: DEFAULT_KEY });
    }
    return this.update(user.id, existing.id, input);
  }

  /**
   * Backward compatibility: a keyless heartbeat to a service without any monitor used to be
   * accepted (monitoring off). Create a disabled "default" monitor so it still is, without alerts.
   */
  ensureDefaultForHeartbeat(service: Service): void {
    if (this.listForService(service.id).length) return;
    const now = new Date();
    const monitor = this.db
      .insert(monitors)
      .values({ id: newId(), serviceId: service.id, key: DEFAULT_KEY, name: 'Default', enabled: false, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning()
      .get();
    if (monitor) this.health.startHistory(monitor);
  }

  /** Called when a service is disabled/suspended/re-enabled: every enabled monitor starts over. */
  resetForService(serviceId: string): void {
    for (const m of this.listForService(serviceId)) if (m.enabled) this.health.resetMonitoring(m.id);
  }

  private findByKey(serviceId: string, key: string): Monitor | undefined {
    return this.db
      .select()
      .from(monitors)
      .where(and(eq(monitors.serviceId, serviceId), eq(monitors.key, key)))
      .get();
  }

  private uniqueKey(serviceId: string, base: string): string {
    if (!this.findByKey(serviceId, base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base.slice(0, 36)}-${i}`;
      if (!this.findByKey(serviceId, candidate)) return candidate;
    }
  }
}

/** Worst state across a service's enabled monitors: DOWN > UNKNOWN > HEALTHY; null if none enabled. */
export function aggregateHealth(list: Array<Pick<Monitor, 'enabled' | 'status'>>): Monitor['status'] | null {
  const active = list.filter((m) => m.enabled);
  if (!active.length) return null;
  if (active.some((m) => m.status === 'DOWN')) return 'DOWN';
  if (active.some((m) => m.status === 'UNKNOWN')) return 'UNKNOWN';
  return 'HEALTHY';
}
