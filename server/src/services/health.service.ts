import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../database/client.js';
import {
  HEALTH_EVENT_TYPES,
  healthEvents,
  monitors,
  services,
  users,
  type HealthEvent,
  type HealthStatus,
  type Monitor,
  type Service,
} from '../database/schema.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { NotificationProvider } from './providers.js';

/** Health history is kept for this many days (plus each monitor's most recent outage). */
export const HISTORY_DAYS = 7;
/** Monitor used by `POST /health/heartbeat` without a key. */
export const DEFAULT_MONITOR_KEY = 'default';
const DAY_MS = 86_400_000;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type HealthEventType = (typeof HEALTH_EVENT_TYPES)[number];

export interface HeartbeatResult {
  monitor: { id: string; key: string; name: string };
  healthStatus: HealthStatus;
  healthEnabled: boolean;
  lastHeartbeatAt: Date;
  /** Latest time the next heartbeat must arrive before the monitor is considered down. */
  nextHeartbeatDeadline: Date | null;
  recovered: boolean;
}

export interface HealthHistory {
  windowStart: Date;
  windowEnd: Date;
  /** Later than windowStart when the monitor is younger than the window. */
  historyStart: Date;
  segments: Array<{ type: HealthEventType; start: Date; end: Date | null }>;
  /** Share of monitored time the monitor was up; null when nothing was monitored. */
  uptimePercent: number | null;
  downtimeSeconds: number;
  outages: number;
  /** Most recent outage, kept even when it is older than the window. */
  lastOutage: HealthEvent | null;
}

/**
 * Lightweight health monitoring with any number of monitors per service.
 *
 * Heartbeats only update the current state on the `monitors` row — they are never stored as
 * records. `health_events` holds one row per outage or monitoring gap, and rows older than
 * HISTORY_DAYS are pruned (except each monitor's latest outage), so storage stays small.
 *
 * State transitions are guarded by conditional UPDATEs (`WHERE status != 'DOWN'`) so each outage
 * produces exactly one DOWN alert and one recovery message.
 */
export class HealthService {
  constructor(
    private readonly db: Db,
    private readonly notifier: NotificationProvider,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Resolve the monitor a heartbeat is for. With a key: that monitor. Without: the `default`
   * monitor, or the only monitor when the service has exactly one.
   */
  resolveMonitor(serviceId: string, key?: string): Monitor {
    if (key) {
      const monitor = this.db
        .select()
        .from(monitors)
        .where(and(eq(monitors.serviceId, serviceId), eq(monitors.key, key)))
        .get();
      if (!monitor) throw new AppError('MONITOR_NOT_FOUND', `This service has no monitor with key "${key}". Create it in the Web App.`);
      return monitor;
    }
    const all = this.db.select().from(monitors).where(eq(monitors.serviceId, serviceId)).all();
    const monitor = all.find((m) => m.key === DEFAULT_MONITOR_KEY) ?? (all.length === 1 ? all[0] : undefined);
    if (!monitor) {
      throw new AppError(
        'MONITOR_NOT_FOUND',
        all.length
          ? 'This service has several monitors: send the heartbeat to /api/v1/health/heartbeat/<monitor key>'
          : 'This service has no health monitor yet. Add one in the Web App.',
      );
    }
    return monitor;
  }

  recordHeartbeat(serviceId: string, key?: string): HeartbeatResult {
    const now = this.now();
    const target = this.resolveMonitor(serviceId, key);

    const outcome = this.db.transaction((tx) => {
      const monitor = tx.select().from(monitors).where(eq(monitors.id, target.id)).get();
      if (!monitor) throw new AppError('MONITOR_NOT_FOUND', 'Monitor not found');

      if (!monitor.enabled) {
        const updated = tx.update(monitors).set({ lastHeartbeatAt: now }).where(eq(monitors.id, monitor.id)).returning().get()!;
        return { monitor: updated, downtimeSeconds: null };
      }

      if (monitor.status === 'DOWN') {
        const downtimeSeconds = monitor.wentDownAt ? Math.max(0, Math.round((now.getTime() - monitor.wentDownAt.getTime()) / 1000)) : 0;
        const updated = tx
          .update(monitors)
          .set({
            status: 'HEALTHY',
            lastHeartbeatAt: now,
            lastRecoveredAt: now,
            wentDownAt: null,
            totalDowntimeSeconds: sql`${monitors.totalDowntimeSeconds} + ${downtimeSeconds}`,
          })
          .where(and(eq(monitors.id, monitor.id), eq(monitors.status, 'DOWN')))
          .returning()
          .get();
        if (updated) {
          this.closeOpen(tx, monitor.id, 'OUTAGE', now);
          return { monitor: updated, downtimeSeconds };
        }
      }

      // First heartbeat after monitoring started: the "no data" gap ends here.
      if (monitor.status === 'UNKNOWN') this.closeOpen(tx, monitor.id, 'NO_DATA', now);
      const updated = tx
        .update(monitors)
        .set({ status: 'HEALTHY', lastHeartbeatAt: now })
        .where(eq(monitors.id, monitor.id))
        .returning()
        .get()!;
      return { monitor: updated, downtimeSeconds: null };
    });

    const m = outcome.monitor;
    const recovered = outcome.downtimeSeconds !== null;
    if (recovered) {
      this.logger.info({ serviceId, monitor: m.key, downtimeSeconds: outcome.downtimeSeconds }, 'Monitor recovered');
      this.notifyOwner(m, (serviceName) => ({
        kind: 'service_recovered',
        serviceName,
        monitorName: m.name,
        recoveredAt: now,
        downtimeSeconds: outcome.downtimeSeconds!,
      }));
    }

    return {
      monitor: { id: m.id, key: m.key, name: m.name },
      healthStatus: m.status,
      healthEnabled: m.enabled,
      lastHeartbeatAt: now,
      nextHeartbeatDeadline: m.enabled ? new Date(now.getTime() + (m.intervalSeconds + m.graceSeconds) * 1000) : null,
      recovered,
    };
  }

  /**
   * Find enabled monitors (of active services of unblocked users) whose last heartbeat is older
   * than interval + grace and mark them DOWN. Monitors that never received a heartbeat stay
   * UNKNOWN. Returns the number of new outages.
   */
  checkOverdue(): number {
    const now = this.now();
    const overdue = this.db
      .select({ id: monitors.id })
      .from(monitors)
      .innerJoin(services, eq(services.id, monitors.serviceId))
      .innerJoin(users, eq(users.id, services.userId))
      .where(
        and(
          eq(monitors.enabled, true),
          eq(services.status, 'ACTIVE'),
          ne(monitors.status, 'DOWN'),
          eq(users.blocked, false),
          isNotNull(monitors.lastHeartbeatAt),
          sql`${monitors.lastHeartbeatAt} + (${monitors.intervalSeconds} + ${monitors.graceSeconds}) * 1000 < ${now.getTime()}`,
        ),
      )
      .all();

    let marked = 0;
    for (const { id } of overdue) {
      const monitor = this.db.transaction((tx) => {
        const updated = tx
          .update(monitors)
          .set({ status: 'DOWN', wentDownAt: now, downCount: sql`${monitors.downCount} + 1` })
          .where(and(eq(monitors.id, id), ne(monitors.status, 'DOWN')))
          .returning()
          .get();
        if (updated) {
          tx.insert(healthEvents).values({ id: newId(), serviceId: updated.serviceId, monitorId: id, eventType: 'OUTAGE', startedAt: now }).run();
        }
        return updated;
      });
      if (!monitor) continue; // Another check (or a heartbeat) got there first.
      marked++;
      this.logger.warn({ monitorId: id, key: monitor.key, lastHeartbeatAt: monitor.lastHeartbeatAt }, 'Monitor marked DOWN');
      this.notifyOwner(monitor, (serviceName) => ({
        kind: 'service_down',
        serviceName,
        monitorName: monitor.name,
        lastHeartbeatAt: monitor.lastHeartbeatAt,
      }));
    }
    return marked;
  }

  /**
   * Called when a monitor is switched on/off, or its service is disabled/suspended/re-enabled.
   * Ends any open outage silently and returns to UNKNOWN; the time until the next heartbeat is
   * recorded as "no data".
   */
  resetMonitoring(monitorId: string): Monitor {
    const now = this.now();
    return this.db.transaction((tx) => {
      const monitor = tx.select().from(monitors).where(eq(monitors.id, monitorId)).get()!;
      const downtimeSeconds =
        monitor.status === 'DOWN' && monitor.wentDownAt ? Math.max(0, Math.round((now.getTime() - monitor.wentDownAt.getTime()) / 1000)) : 0;
      if (monitor.status === 'DOWN') this.closeOpen(tx, monitorId, 'OUTAGE', now);
      this.openNoData(tx, monitor, now);
      return tx
        .update(monitors)
        .set({
          status: 'UNKNOWN',
          wentDownAt: null,
          lastHeartbeatAt: null,
          totalDowntimeSeconds: sql`${monitors.totalDowntimeSeconds} + ${downtimeSeconds}`,
        })
        .where(eq(monitors.id, monitorId))
        .returning()
        .get();
    });
  }

  /** Start of history for a new monitor: nothing is known until the first heartbeat. */
  startHistory(monitor: Monitor): void {
    this.db.transaction((tx) => this.openNoData(tx, monitor, this.now()));
  }

  /** Outage history of one service (all its monitors), newest first. */
  serviceOutages(serviceId: string, limit = 50) {
    return this.db
      .select({ event: healthEvents, monitorName: monitors.name, monitorKey: monitors.key })
      .from(healthEvents)
      .innerJoin(monitors, eq(monitors.id, healthEvents.monitorId))
      .where(and(eq(healthEvents.serviceId, serviceId), eq(healthEvents.eventType, 'OUTAGE')))
      .orderBy(desc(healthEvents.startedAt))
      .limit(limit)
      .all()
      .map((r) => ({ ...r.event, monitorName: r.monitorName, monitorKey: r.monitorKey }));
  }

  recentOutagesForUser(userId: string, limit = 50) {
    return this.db
      .select({ event: healthEvents, serviceName: services.name, monitorName: monitors.name })
      .from(healthEvents)
      .innerJoin(services, eq(services.id, healthEvents.serviceId))
      .innerJoin(monitors, eq(monitors.id, healthEvents.monitorId))
      .where(and(eq(services.userId, userId), eq(healthEvents.eventType, 'OUTAGE')))
      .orderBy(desc(healthEvents.startedAt))
      .limit(limit)
      .all()
      .map((r) => ({ ...r.event, serviceName: r.serviceName, monitorName: r.monitorName }));
  }

  /**
   * Health history for the last `days` days per monitor, derived from the stored events (no
   * per-heartbeat data): outage and no-data segments clipped to the window, uptime over the
   * monitored time, and the most recent outage even when it is older than the window.
   */
  history(list: Array<Pick<Monitor, 'id' | 'createdAt'>>, days = HISTORY_DAYS): Map<string, HealthHistory> {
    const now = this.now().getTime();
    const from = now - days * DAY_MS;
    const result = new Map<string, HealthHistory>();
    if (!list.length) return result;
    const ids = list.map((m) => m.id);

    const rows = this.db
      .select()
      .from(healthEvents)
      .where(and(inArray(healthEvents.monitorId, ids), or(isNull(healthEvents.endedAt), gte(healthEvents.endedAt, new Date(from)))))
      .orderBy(asc(healthEvents.startedAt))
      .all();
    const last = this.lastOutages(ids);

    for (const monitor of list) {
      const start = Math.max(from, monitor.createdAt.getTime());
      const segments = rows
        .filter((r) => r.monitorId === monitor.id && r.startedAt.getTime() < now)
        .map((r) => ({
          type: r.eventType,
          start: new Date(Math.max(start, r.startedAt.getTime())),
          end: r.endedAt ? new Date(Math.min(now, r.endedAt.getTime())) : null,
        }))
        .filter((seg) => (seg.end ?? new Date(now)).getTime() > seg.start.getTime());

      const total = (type: HealthEventType) =>
        segments.filter((seg) => seg.type === type).reduce((sum, seg) => sum + ((seg.end?.getTime() ?? now) - seg.start.getTime()), 0);
      const noDataMs = total('NO_DATA');
      const downMs = total('OUTAGE');
      const monitoredMs = Math.max(0, now - start - noDataMs);

      result.set(monitor.id, {
        windowStart: new Date(from),
        windowEnd: new Date(now),
        historyStart: new Date(start),
        segments,
        uptimePercent: monitoredMs > 0 ? Math.round(Math.max(0, (monitoredMs - downMs) / monitoredMs) * 10000) / 100 : null,
        downtimeSeconds: Math.round(downMs / 1000),
        outages: segments.filter((seg) => seg.type === 'OUTAGE').length,
        lastOutage: last.get(monitor.id) ?? null,
      });
    }
    return result;
  }

  /**
   * Retention: delete finished events that ended more than `days` ago, but always keep each
   * monitor's most recent outage so "last time it was down" survives a quiet week.
   */
  prune(days = HISTORY_DAYS): number {
    const cutoff = this.now().getTime() - days * DAY_MS;
    const result = this.db.$client
      .prepare(
        `DELETE FROM health_events
         WHERE ended_at IS NOT NULL AND ended_at < ?
           AND id NOT IN (
             SELECT (SELECT h2.id FROM health_events h2
                     WHERE h2.monitor_id = h.monitor_id AND h2.event_type = 'OUTAGE'
                     ORDER BY h2.started_at DESC LIMIT 1)
             FROM health_events h WHERE h.event_type = 'OUTAGE' GROUP BY h.monitor_id
           )`,
      )
      .run(cutoff);
    if (result.changes) this.logger.info({ deleted: result.changes, days }, 'Pruned old health events');
    return result.changes;
  }

  private lastOutages(monitorIds: string[]): Map<string, HealthEvent> {
    const rows = this.db
      .select()
      .from(healthEvents)
      .where(and(inArray(healthEvents.monitorId, monitorIds), eq(healthEvents.eventType, 'OUTAGE')))
      .orderBy(desc(healthEvents.startedAt))
      .all();
    const map = new Map<string, HealthEvent>();
    for (const row of rows) if (!map.has(row.monitorId)) map.set(row.monitorId, row);
    return map;
  }

  private openNoData(tx: Tx, monitor: Pick<Monitor, 'id' | 'serviceId'>, at: Date): void {
    const open = tx
      .select({ id: healthEvents.id })
      .from(healthEvents)
      .where(and(eq(healthEvents.monitorId, monitor.id), eq(healthEvents.eventType, 'NO_DATA'), isNull(healthEvents.endedAt)))
      .get();
    if (!open) {
      tx.insert(healthEvents).values({ id: newId(), serviceId: monitor.serviceId, monitorId: monitor.id, eventType: 'NO_DATA', startedAt: at }).run();
    }
  }

  private closeOpen(tx: Tx, monitorId: string, type: HealthEventType, now: Date): void {
    tx.update(healthEvents)
      .set({
        endedAt: now,
        durationSeconds: sql`MAX(0, CAST((${now.getTime()} - ${healthEvents.startedAt}) / 1000 AS INTEGER))`,
      })
      .where(and(eq(healthEvents.monitorId, monitorId), eq(healthEvents.eventType, type), isNull(healthEvents.endedAt)))
      .run();
  }

  private notifyOwner(monitor: Monitor, build: (serviceName: string) => Parameters<NotificationProvider['notify']>[1]): void {
    if (!monitor.notify) return;
    const owner = this.db
      .select({ serviceName: services.name, telegramId: users.telegramId, notifyHealth: users.notifyHealth, blocked: users.blocked })
      .from(services)
      .innerJoin(users, eq(users.id, services.userId))
      .where(eq(services.id, monitor.serviceId))
      .get();
    if (!owner || !owner.notifyHealth || owner.blocked) return;
    void this.notifier.notify({ telegramId: owner.telegramId }, build(owner.serviceName));
  }
}

export type { Service };
