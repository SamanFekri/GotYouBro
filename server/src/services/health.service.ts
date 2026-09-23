import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../database/client.js';
import { healthEvents, services, users, type HealthStatus, type Service } from '../database/schema.js';
import { newId } from '../lib/ids.js';
import type { NotificationProvider } from './providers.js';

export interface HeartbeatResult {
  healthStatus: HealthStatus;
  healthEnabled: boolean;
  lastHeartbeatAt: Date;
  /** Latest time the next heartbeat must arrive before the service is considered down. */
  nextHeartbeatDeadline: Date | null;
  recovered: boolean;
}

/**
 * Lightweight health monitoring.
 *
 * Heartbeats only update the current state on the `services` row — they are never stored as
 * records. A `health_events` row is created per outage, so storage grows with incidents rather
 * than heartbeat frequency.
 *
 * State transitions are guarded by conditional UPDATEs (`WHERE health_status != 'DOWN'`) so each
 * outage produces exactly one DOWN alert and one recovery message.
 */
export class HealthService {
  constructor(
    private readonly db: Db,
    private readonly notifier: NotificationProvider,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  recordHeartbeat(serviceId: string): HeartbeatResult {
    const now = this.now();

    const outcome = this.db.transaction((tx) => {
      const service = tx.select().from(services).where(eq(services.id, serviceId)).get();
      if (!service) throw new Error(`Service ${serviceId} disappeared`);

      if (!service.healthEnabled) {
        tx.update(services).set({ lastHeartbeatAt: now }).where(eq(services.id, serviceId)).run();
        return { service: { ...service, lastHeartbeatAt: now }, downtimeSeconds: null };
      }

      if (service.healthStatus === 'DOWN') {
        const downtimeSeconds = service.wentDownAt ? Math.max(0, Math.round((now.getTime() - service.wentDownAt.getTime()) / 1000)) : 0;
        const updated = tx
          .update(services)
          .set({
            healthStatus: 'HEALTHY',
            lastHeartbeatAt: now,
            lastRecoveredAt: now,
            wentDownAt: null,
            totalDowntimeSeconds: sql`${services.totalDowntimeSeconds} + ${downtimeSeconds}`,
          })
          .where(and(eq(services.id, serviceId), eq(services.healthStatus, 'DOWN')))
          .returning()
          .get();
        if (updated) {
          this.closeOpenOutage(tx, serviceId, now);
          return { service: updated, downtimeSeconds };
        }
      }

      const updated = tx
        .update(services)
        .set({ healthStatus: 'HEALTHY', lastHeartbeatAt: now })
        .where(eq(services.id, serviceId))
        .returning()
        .get()!;
      return { service: updated, downtimeSeconds: null };
    });

    const recovered = outcome.downtimeSeconds !== null;
    if (recovered) {
      this.logger.info({ serviceId, downtimeSeconds: outcome.downtimeSeconds }, 'Service recovered');
      this.notifyOwner(outcome.service, {
        kind: 'service_recovered',
        serviceName: outcome.service.name,
        recoveredAt: now,
        downtimeSeconds: outcome.downtimeSeconds!,
      });
    }

    const s = outcome.service;
    return {
      healthStatus: s.healthStatus,
      healthEnabled: s.healthEnabled,
      lastHeartbeatAt: now,
      nextHeartbeatDeadline: s.healthEnabled ? new Date(now.getTime() + (s.healthIntervalSeconds + s.healthGraceSeconds) * 1000) : null,
      recovered,
    };
  }

  /**
   * Find monitored services whose last heartbeat is older than interval + grace and mark them
   * DOWN. Services that never sent a heartbeat stay UNKNOWN. Returns the number of new outages.
   */
  checkOverdue(): number {
    const now = this.now();
    const overdue = this.db
      .select({ id: services.id })
      .from(services)
      .innerJoin(users, eq(users.id, services.userId))
      .where(
        and(
          eq(services.healthEnabled, true),
          eq(services.status, 'ACTIVE'),
          ne(services.healthStatus, 'DOWN'),
          eq(users.blocked, false),
          isNotNull(services.lastHeartbeatAt),
          sql`${services.lastHeartbeatAt} + (${services.healthIntervalSeconds} + ${services.healthGraceSeconds}) * 1000 < ${now.getTime()}`,
        ),
      )
      .all();

    let marked = 0;
    for (const { id } of overdue) {
      const service = this.db.transaction((tx) => {
        const updated = tx
          .update(services)
          .set({ healthStatus: 'DOWN', wentDownAt: now, downCount: sql`${services.downCount} + 1` })
          .where(and(eq(services.id, id), ne(services.healthStatus, 'DOWN')))
          .returning()
          .get();
        if (updated) {
          tx.insert(healthEvents).values({ id: newId(), serviceId: id, eventType: 'OUTAGE', startedAt: now }).run();
        }
        return updated;
      });
      if (!service) continue; // Another check (or a heartbeat) got there first.
      marked++;
      this.logger.warn({ serviceId: id, lastHeartbeatAt: service.lastHeartbeatAt }, 'Service marked DOWN');
      this.notifyOwner(service, { kind: 'service_down', serviceName: service.name, lastHeartbeatAt: service.lastHeartbeatAt });
    }
    return marked;
  }

  /**
   * Called when monitoring is switched on/off (or the service is disabled/suspended). Ends any
   * open outage silently and returns to UNKNOWN until the next heartbeat.
   */
  resetMonitoring(serviceId: string): Service {
    const now = this.now();
    return this.db.transaction((tx) => {
      const service = tx.select().from(services).where(eq(services.id, serviceId)).get()!;
      const downtimeSeconds =
        service.healthStatus === 'DOWN' && service.wentDownAt ? Math.max(0, Math.round((now.getTime() - service.wentDownAt.getTime()) / 1000)) : 0;
      if (service.healthStatus === 'DOWN') this.closeOpenOutage(tx, serviceId, now);
      return tx
        .update(services)
        .set({
          healthStatus: 'UNKNOWN',
          wentDownAt: null,
          lastHeartbeatAt: null,
          totalDowntimeSeconds: sql`${services.totalDowntimeSeconds} + ${downtimeSeconds}`,
        })
        .where(eq(services.id, serviceId))
        .returning()
        .get();
    });
  }

  events(serviceId: string, limit = 50) {
    return this.db
      .select()
      .from(healthEvents)
      .where(eq(healthEvents.serviceId, serviceId))
      .orderBy(desc(healthEvents.startedAt))
      .limit(limit)
      .all();
  }

  recentEventsForUser(userId: string, limit = 50) {
    return this.db
      .select({ event: healthEvents, serviceName: services.name })
      .from(healthEvents)
      .innerJoin(services, eq(services.id, healthEvents.serviceId))
      .where(eq(services.userId, userId))
      .orderBy(desc(healthEvents.startedAt))
      .limit(limit)
      .all()
      .map((r) => ({ ...r.event, serviceName: r.serviceName }));
  }

  private closeOpenOutage(tx: Parameters<Parameters<Db['transaction']>[0]>[0], serviceId: string, now: Date): void {
    tx.update(healthEvents)
      .set({
        endedAt: now,
        durationSeconds: sql`MAX(0, CAST((${now.getTime()} - ${healthEvents.startedAt}) / 1000 AS INTEGER))`,
      })
      .where(and(eq(healthEvents.serviceId, serviceId), isNull(healthEvents.endedAt)))
      .run();
  }

  private notifyOwner(service: Service, message: Parameters<NotificationProvider['notify']>[1]): void {
    if (!service.healthNotify) return;
    const owner = this.db
      .select({ telegramId: users.telegramId, notifyHealth: users.notifyHealth, blocked: users.blocked })
      .from(users)
      .where(eq(users.id, service.userId))
      .get();
    if (!owner || !owner.notifyHealth || owner.blocked) return;
    void this.notifier.notify({ telegramId: owner.telegramId }, message);
  }
}
