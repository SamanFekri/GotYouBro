import { desc, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../database/client.js';
import { auditLogs, users } from '../database/schema.js';
import { newId } from '../lib/ids.js';

export interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

/** Records important admin and security actions. Never pass secrets in `metadata`. */
export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  log(entry: AuditEntry): void {
    try {
      this.db
        .insert(auditLogs)
        .values({
          id: newId(),
          actorUserId: entry.actorUserId ?? null,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          metadata: entry.metadata ?? null,
          ip: entry.ip ?? null,
          createdAt: new Date(),
        })
        .run();
      this.logger.info({ audit: entry.action, actor: entry.actorUserId, target: entry.targetId }, 'audit');
    } catch (err) {
      // Auditing must never break the action being audited.
      this.logger.error({ err, action: entry.action }, 'Failed to write audit log');
    }
  }

  list(limit: number, offset: number) {
    const rows = this.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        metadata: auditLogs.metadata,
        ip: auditLogs.ip,
        createdAt: auditLogs.createdAt,
        actorUserId: auditLogs.actorUserId,
        actorTelegramId: users.telegramId,
        actorUsername: users.username,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset)
      .all();
    const total = this.db.select({ n: sql<number>`count(*)` }).from(auditLogs).get()?.n ?? 0;
    return { items: rows, total };
  }
}
