import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../database/client.js';
import { backups, destinations, healthEvents, monitors, services, users } from '../database/schema.js';

const DAY_MS = 86_400_000;

export class StatsService {
  constructor(private readonly db: Db) {}

  dashboard(userId: string) {
    const since = new Date(Date.now() - DAY_MS * 7);
    const total = this.db.select({ n: sql<number>`count(*)` }).from(services).where(eq(services.userId, userId)).get()?.n ?? 0;
    const activeMonitors = this.db
      .select({ serviceId: monitors.serviceId, status: monitors.status })
      .from(monitors)
      .innerJoin(services, eq(services.id, monitors.serviceId))
      .where(and(eq(services.userId, userId), eq(monitors.enabled, true)))
      .all();
    // A service's health is the worst state of its enabled monitors.
    const byService = new Map<string, string[]>();
    for (const m of activeMonitors) byService.set(m.serviceId, [...(byService.get(m.serviceId) ?? []), m.status]);
    const worst = [...byService.values()].map((st) => (st.includes('DOWN') ? 'DOWN' : st.includes('UNKNOWN') ? 'UNKNOWN' : 'HEALTHY'));
    const svc = {
      total,
      monitored: byService.size,
      healthy: worst.filter((w) => w === 'HEALTHY').length,
      down: worst.filter((w) => w === 'DOWN').length,
      monitors: activeMonitors.length,
      monitorsDown: activeMonitors.filter((m) => m.status === 'DOWN').length,
    };
    const bk = this.db
      .select({
        recent: sql<number>`count(*)`,
        failed: sql<number>`coalesce(sum(${backups.status} = 'FAILED'), 0)`,
        succeeded: sql<number>`coalesce(sum(${backups.status} = 'SUCCESS'), 0)`,
        bytes: sql<number>`coalesce(sum(CASE WHEN ${backups.status} = 'SUCCESS' THEN ${backups.sizeBytes} END), 0)`,
      })
      .from(backups)
      .where(and(eq(backups.userId, userId), gte(backups.createdAt, since)))
      .get()!;
    return {
      totalServices: svc.total,
      monitoredServices: svc.monitored,
      activeMonitors: svc.monitors,
      downMonitors: svc.monitorsDown,
      healthyServices: svc.healthy,
      downServices: svc.down,
      recentBackups: bk.recent,
      successfulBackups: bk.succeeded,
      failedBackups: bk.failed,
      recentBackupBytes: bk.bytes,
      periodDays: 7,
    };
  }

  system() {
    const since = new Date(Date.now() - DAY_MS);
    const count = (q: { n: number } | undefined) => q?.n ?? 0;
    const n = sql<number>`count(*)`;
    return {
      users: {
        total: count(this.db.select({ n }).from(users).get()),
        blocked: count(this.db.select({ n }).from(users).where(eq(users.blocked, true)).get()),
        activeLast24h: count(this.db.select({ n }).from(users).where(gte(users.lastSeenAt, since)).get()),
      },
      services: {
        total: count(this.db.select({ n }).from(services).get()),
        suspended: count(this.db.select({ n }).from(services).where(eq(services.status, 'SUSPENDED')).get()),
        monitored: count(this.db.select({ n: sql<number>`count(DISTINCT ${monitors.serviceId})` }).from(monitors).where(eq(monitors.enabled, true)).get()),
        down: count(
          this.db
            .select({ n: sql<number>`count(DISTINCT ${monitors.serviceId})` })
            .from(monitors)
            .where(and(eq(monitors.enabled, true), eq(monitors.status, 'DOWN')))
            .get(),
        ),
      },
      monitors: {
        total: count(this.db.select({ n }).from(monitors).get()),
        active: count(this.db.select({ n }).from(monitors).where(eq(monitors.enabled, true)).get()),
        down: count(this.db.select({ n }).from(monitors).where(and(eq(monitors.enabled, true), eq(monitors.status, 'DOWN'))).get()),
      },
      destinations: count(this.db.select({ n }).from(destinations).get()),
      backups: {
        total: count(this.db.select({ n }).from(backups).get()),
        last24h: count(this.db.select({ n }).from(backups).where(gte(backups.createdAt, since)).get()),
        failedLast24h: count(this.db.select({ n }).from(backups).where(and(gte(backups.createdAt, since), eq(backups.status, 'FAILED'))).get()),
        bytesLast24h:
          this.db
            .select({ n: sql<number>`coalesce(sum(${backups.sizeBytes}), 0)` })
            .from(backups)
            .where(and(gte(backups.createdAt, since), eq(backups.status, 'SUCCESS')))
            .get()?.n ?? 0,
      },
      outagesLast24h: count(this.db.select({ n }).from(healthEvents).where(gte(healthEvents.startedAt, since)).get()),
    };
  }
}
