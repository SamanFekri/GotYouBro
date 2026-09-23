import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`)
    .$onUpdate(() => new Date()),
};

export const USER_ROLES = ['USER', 'ADMIN'] as const;
export const SERVICE_STATUSES = ['ACTIVE', 'DISABLED', 'SUSPENDED'] as const;
export const HEALTH_STATUSES = ['UNKNOWN', 'HEALTHY', 'DOWN'] as const;
export const DESTINATION_TYPES = ['PRIVATE_CHAT', 'GROUP', 'GROUP_TOPIC', 'CHANNEL'] as const;
export const BACKUP_STATUSES = ['RECEIVED', 'PROCESSING', 'SUCCESS', 'FAILED'] as const;

export type UserRole = (typeof USER_ROLES)[number];
/** ACTIVE / DISABLED are controlled by the owner; SUSPENDED is set by an admin and only an admin can lift it. */
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];
export type HealthStatus = (typeof HEALTH_STATUSES)[number];
export type DestinationType = (typeof DESTINATION_TYPES)[number];
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  telegramId: integer('telegram_id', { mode: 'number' }).notNull().unique(),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  role: text('role', { enum: USER_ROLES }).notNull().default('USER'),
  blocked: integer('blocked', { mode: 'boolean' }).notNull().default(false),
  blockedReason: text('blocked_reason'),
  notifyHealth: integer('notify_health', { mode: 'boolean' }).notNull().default(true),
  notifyBackupFailures: integer('notify_backup_failures', { mode: 'boolean' }).notNull().default(true),
  /** Per-user overrides set by admins; null means "use the global default". */
  maxServices: integer('max_services'),
  maxBackupSizeMb: integer('max_backup_size_mb'),
  apiRateLimit: text('api_rate_limit'),
  backupRateLimit: text('backup_rate_limit'),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  ...timestamps,
});

export const destinations = sqliteTable(
  'destinations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: DESTINATION_TYPES }).notNull(),
    telegramChatId: integer('telegram_chat_id', { mode: 'number' }).notNull(),
    telegramThreadId: integer('telegram_thread_id', { mode: 'number' }),
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
    verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [index('destinations_user_idx').on(t.userId)],
);

export const services = sqliteTable(
  'services',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status', { enum: SERVICE_STATUSES }).notNull().default('ACTIVE'),
    apiEnabled: integer('api_enabled', { mode: 'boolean' }).notNull().default(true),
    destinationId: text('destination_id').references(() => destinations.id, { onDelete: 'set null' }),

    // Health monitoring: current state + aggregates only. Heartbeats are never stored individually.
    healthEnabled: integer('health_enabled', { mode: 'boolean' }).notNull().default(false),
    healthNotify: integer('health_notify', { mode: 'boolean' }).notNull().default(true),
    healthStatus: text('health_status', { enum: HEALTH_STATUSES }).notNull().default('UNKNOWN'),
    healthIntervalSeconds: integer('health_interval_seconds').notNull().default(60),
    healthGraceSeconds: integer('health_grace_seconds').notNull().default(60),
    lastHeartbeatAt: integer('last_heartbeat_at', { mode: 'timestamp_ms' }),
    wentDownAt: integer('went_down_at', { mode: 'timestamp_ms' }),
    lastRecoveredAt: integer('last_recovered_at', { mode: 'timestamp_ms' }),
    totalDowntimeSeconds: integer('total_downtime_seconds').notNull().default(0),
    downCount: integer('down_count').notNull().default(0),

    // Backup aggregates (avoid COUNT(*) scans for the service list).
    lastBackupAt: integer('last_backup_at', { mode: 'timestamp_ms' }),
    backupCount: integer('backup_count').notNull().default(0),

    // Per-service overrides set by admins; null means "use the user/global limit".
    maxBackupSizeMb: integer('max_backup_size_mb'),
    apiRateLimit: text('api_rate_limit'),
    backupRateLimit: text('backup_rate_limit'),
    heartbeatRateLimit: text('heartbeat_rate_limit'),
    ...timestamps,
  },
  (t) => [index('services_user_idx').on(t.userId), index('services_health_idx').on(t.healthEnabled, t.healthStatus)],
);

export const apiCredentials = sqliteTable(
  'api_credentials',
  {
    id: text('id').primaryKey(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    /** SHA-256 of the full token. The plaintext token is only ever shown once. */
    tokenHash: text('token_hash').notNull().unique(),
    /** First characters of the token, safe to display and log (e.g. `gyb_AbCd1234`). */
    tokenPrefix: text('token_prefix').notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('api_credentials_service_idx').on(t.serviceId)],
);

export const backups = sqliteTable(
  'backups',
  {
    id: text('id').primaryKey(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    destinationId: text('destination_id').references(() => destinations.id, { onDelete: 'set null' }),
    /** Snapshot so history stays readable after a destination is deleted. */
    destinationName: text('destination_name'),
    filename: text('filename').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status', { enum: BACKUP_STATUSES }).notNull().default('RECEIVED'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamps.createdAt,
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('backups_idempotency_idx').on(t.serviceId, t.idempotencyKey),
    index('backups_user_created_idx').on(t.userId, t.createdAt),
    index('backups_service_created_idx').on(t.serviceId, t.createdAt),
  ],
);

/** One row per outage (not per heartbeat), so size grows with incidents only. */
export const healthEvents = sqliteTable(
  'health_events',
  {
    id: text('id').primaryKey(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    eventType: text('event_type', { enum: ['OUTAGE'] }).notNull().default('OUTAGE'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    durationSeconds: integer('duration_seconds'),
  },
  (t) => [index('health_events_service_idx').on(t.serviceId, t.startedAt)],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    ip: text('ip'),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('audit_logs_created_idx').on(t.createdAt)],
);

/** Admin-editable runtime settings (e.g. default limits). Small key/value store. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: timestamps.updatedAt,
});

export type User = typeof users.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Destination = typeof destinations.$inferSelect;
export type Backup = typeof backups.$inferSelect;
export type ApiCredential = typeof apiCredentials.$inferSelect;
export type HealthEvent = typeof healthEvents.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
