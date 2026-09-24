import fs from 'node:fs/promises';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../database/client.js';
import { backups, destinations, services, users, type Backup, type BackupStatus, type Destination, type Service, type User } from '../database/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { TelegramApiError } from '../telegram/gateway.js';
import type { BackupDestinationProvider, NotificationProvider } from './providers.js';

export interface NewBackup {
  service: Service;
  user: User;
  destination: Destination;
  filename: string;
  sizeBytes: number;
  idempotencyKey?: string;
}

export interface BackupFilters {
  serviceId?: string;
  status?: BackupStatus;
  limit: number;
  offset: number;
}

/** Fields returned by the public API (no internal ids of other entities). */
export function toPublicBackup(b: Backup) {
  return {
    id: b.id,
    serviceId: b.serviceId,
    filename: b.filename,
    sizeBytes: b.sizeBytes,
    status: b.status,
    error: b.errorCode ? { code: b.errorCode, message: b.errorMessage } : null,
    createdAt: b.createdAt,
    completedAt: b.completedAt,
  };
}

export class BackupsService {
  constructor(
    private readonly db: Db,
    private readonly destinationProvider: BackupDestinationProvider,
    private readonly notifier: NotificationProvider,
    private readonly logger: Logger,
  ) {}

  /** Ensure the service has a usable destination before accepting any upload bytes. */
  resolveDestination(service: Service): Destination {
    if (!service.destinationId) {
      throw new AppError('DESTINATION_NOT_CONFIGURED', 'No backup destination is configured for this service');
    }
    const destination = this.db.select().from(destinations).where(eq(destinations.id, service.destinationId)).get();
    if (!destination) throw new AppError('DESTINATION_NOT_CONFIGURED', 'No backup destination is configured for this service');
    if (!destination.verified) {
      throw new AppError('DESTINATION_NOT_VERIFIED', 'The backup destination has not been verified. Verify it in the Web App.');
    }
    return destination;
  }

  findByIdempotencyKey(serviceId: string, key: string): Backup | undefined {
    return this.db
      .select()
      .from(backups)
      .where(and(eq(backups.serviceId, serviceId), eq(backups.idempotencyKey, key)))
      .get();
  }

  /** Detach the key from a failed backup so a retry with the same key creates a new attempt. */
  releaseIdempotencyKey(backupId: string): void {
    this.db.update(backups).set({ idempotencyKey: null }).where(eq(backups.id, backupId)).run();
  }

  /** Insert the RECEIVED record. Concurrent duplicates with the same Idempotency-Key resolve to one row. */
  createRecord(input: NewBackup): { backup: Backup; duplicate: boolean } {
    try {
      const backup = this.db
        .insert(backups)
        .values({
          id: newId(),
          serviceId: input.service.id,
          userId: input.user.id,
          destinationId: input.destination.id,
          destinationName: input.destination.name,
          filename: input.filename,
          sizeBytes: input.sizeBytes,
          status: 'RECEIVED',
          idempotencyKey: input.idempotencyKey ?? null,
          createdAt: new Date(),
        })
        .returning()
        .get();
      return { backup, duplicate: false };
    } catch (err) {
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = this.findByIdempotencyKey(input.service.id, input.idempotencyKey);
        if (existing) return { backup: existing, duplicate: true };
      }
      throw err;
    }
  }

  /** Deliver a received backup. Always removes the temporary file. Never throws. */
  async process(backupId: string, filePath: string): Promise<Backup> {
    try {
      const row = this.db
        .select({ backup: backups, service: services, destination: destinations })
        .from(backups)
        .innerJoin(services, eq(services.id, backups.serviceId))
        .leftJoin(destinations, eq(destinations.id, backups.destinationId))
        .where(eq(backups.id, backupId))
        .get();
      if (!row) throw new Error(`Backup ${backupId} not found`);

      if (!row.destination) {
        return this.fail(row.backup, row.service, 'DESTINATION_NOT_CONFIGURED', 'Destination was removed before delivery');
      }

      this.db.update(backups).set({ status: 'PROCESSING' }).where(eq(backups.id, backupId)).run();

      try {
        await this.destinationProvider.deliver(
          row.destination,
          { path: filePath, filename: row.backup.filename, sizeBytes: row.backup.sizeBytes },
          { backupId, serviceName: row.service.name, createdAt: row.backup.createdAt },
        );
      } catch (err) {
        const reason = err instanceof TelegramApiError ? err.message : 'Unexpected delivery error';
        this.logger.warn({ backupId, err: (err as Error).message }, 'Backup delivery failed');
        return this.fail(row.backup, row.service, 'TELEGRAM_DELIVERY_FAILED', reason);
      }

      const now = new Date();
      const done = this.db.transaction((tx) => {
        tx.update(services)
          .set({ lastBackupAt: now, backupCount: sql`${services.backupCount} + 1` })
          .where(eq(services.id, row.service.id))
          .run();
        return tx.update(backups).set({ status: 'SUCCESS', completedAt: now }).where(eq(backups.id, backupId)).returning().get();
      });
      this.logger.info({ backupId, serviceId: row.service.id, sizeBytes: row.backup.sizeBytes }, 'Backup delivered');
      return done;
    } catch (err) {
      this.logger.error({ err, backupId }, 'Backup processing crashed');
      return this.db
        .update(backups)
        .set({ status: 'FAILED', errorCode: 'INTERNAL_ERROR', errorMessage: 'Internal error', completedAt: new Date() })
        .where(eq(backups.id, backupId))
        .returning()
        .get();
    } finally {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  private fail(backup: Backup, service: Service, code: string, message: string): Backup {
    const failed = this.db
      .update(backups)
      .set({ status: 'FAILED', errorCode: code, errorMessage: message.slice(0, 500), completedAt: new Date() })
      .where(eq(backups.id, backup.id))
      .returning()
      .get();
    const owner = this.db.select().from(users).where(eq(users.id, service.userId)).get();
    if (owner?.notifyBackupFailures && !owner.blocked) {
      void this.notifier.notify(
        { telegramId: owner.telegramId },
        { kind: 'backup_failed', serviceName: service.name, backupId: backup.id, filename: backup.filename, reason: message },
      );
    }
    return failed;
  }

  getForService(serviceId: string, id: string): Backup {
    const backup = this.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, id), eq(backups.serviceId, serviceId)))
      .get();
    if (!backup) throw notFound('BACKUP_NOT_FOUND', 'Backup');
    return backup;
  }

  getOwned(userId: string, id: string) {
    const row = this.list({ userId }, { limit: 1, offset: 0 }, eq(backups.id, id)).items[0];
    if (!row) throw notFound('BACKUP_NOT_FOUND', 'Backup');
    return row;
  }

  /** `scope.userId` restricts to one owner; omit it only for admin listings. */
  list(scope: { userId?: string }, filters: Partial<BackupFilters> & { limit: number; offset: number }, extra?: SQL) {
    const conditions: SQL[] = [];
    if (scope.userId) conditions.push(eq(backups.userId, scope.userId));
    if (filters.serviceId) conditions.push(eq(backups.serviceId, filters.serviceId));
    if (filters.status) conditions.push(eq(backups.status, filters.status));
    if (extra) conditions.push(extra);
    const where = conditions.length ? and(...conditions) : undefined;

    const items = this.db
      .select({
        id: backups.id,
        serviceId: backups.serviceId,
        serviceName: services.name,
        userId: backups.userId,
        filename: backups.filename,
        sizeBytes: backups.sizeBytes,
        status: backups.status,
        errorCode: backups.errorCode,
        errorMessage: backups.errorMessage,
        destinationId: backups.destinationId,
        destinationName: backups.destinationName,
        createdAt: backups.createdAt,
        completedAt: backups.completedAt,
      })
      .from(backups)
      .innerJoin(services, eq(services.id, backups.serviceId))
      .where(where)
      .orderBy(desc(backups.createdAt))
      .limit(filters.limit)
      .offset(filters.offset)
      .all();
    const total = this.db.select({ n: sql<number>`count(*)` }).from(backups).where(where).get()?.n ?? 0;
    return { items, total };
  }

  /** On startup: anything still in flight belonged to a previous process and its temp file is gone. */
  failInterrupted(): number {
    return this.db
      .update(backups)
      .set({ status: 'FAILED', errorCode: 'INTERRUPTED', errorMessage: 'Server restarted before delivery', completedAt: new Date() })
      .where(inArray(backups.status, ['RECEIVED', 'PROCESSING']))
      .run().changes;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE';
}
