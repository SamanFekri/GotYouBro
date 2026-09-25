import type { Destination } from '../database/schema.js';

/**
 * Provider abstractions so the core backup / notification logic is not tied to Telegram.
 * Only Telegram implementations exist today; S3 or other targets would implement the same shapes.
 */

export interface BackupFile {
  path: string;
  filename: string;
  sizeBytes: number;
}

export interface BackupMetadata {
  backupId: string;
  serviceName: string;
  createdAt: Date;
}

export interface BackupDestinationProvider {
  deliver(destination: Destination, file: BackupFile, metadata: BackupMetadata): Promise<{ externalId: string }>;
}

export interface NotificationTarget {
  telegramId: number;
}

export interface NotificationProvider {
  /** Send a short message to a user. Implementations must not throw for delivery failures. */
  notify(target: NotificationTarget, message: NotificationMessage): Promise<boolean>;
}

export type NotificationMessage =
  | { kind: 'service_down'; serviceName: string; monitorName: string; lastHeartbeatAt: Date | null }
  | { kind: 'service_recovered'; serviceName: string; monitorName: string; recoveredAt: Date; downtimeSeconds: number }
  | { kind: 'backup_failed'; serviceName: string; backupId: string; filename: string; reason: string };
