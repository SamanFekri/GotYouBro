import type { Logger } from 'pino';
import type { AppConfig } from './config/index.js';
import type { Db } from './database/client.js';
import { LimitsService } from './rate-limit/limits.js';
import { RateLimiter } from './rate-limit/rate-limit.js';
import { AuditService } from './services/audit.service.js';
import { BackupsService } from './services/backups.service.js';
import { CredentialsService } from './services/credentials.service.js';
import { DestinationsService } from './services/destinations.service.js';
import { HealthService } from './services/health.service.js';
import { MonitorsService } from './services/monitors.service.js';
import type { BackupDestinationProvider, NotificationProvider } from './services/providers.js';
import { ServicesService } from './services/services.service.js';
import { SettingsService } from './services/settings.service.js';
import { StatsService } from './services/stats.service.js';
import { UsersService } from './services/users.service.js';
import type { TelegramGateway } from './telegram/gateway.js';
import { TelegramBackupDestination } from './telegram/telegram-backup-destination.js';
import { TelegramNotificationProvider } from './telegram/telegram-notification-provider.js';
import { BackupQueue } from './workers/backup-queue.js';
import { HealthMonitor } from './workers/health-monitor.js';

export interface ContextDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
  telegram: TelegramGateway;
  /** Overrides for tests. */
  backupDestination?: BackupDestinationProvider;
  notifier?: NotificationProvider;
  now?: () => Date;
}

/** Composition root: wires business services, providers and workers together. */
export function createContext(deps: ContextDeps) {
  const { config, db, logger, telegram } = deps;
  const limiter = new RateLimiter(deps.now ? () => deps.now!().getTime() : Date.now);
  const settings = new SettingsService(db, config);
  const limits = new LimitsService(settings, config);
  const notifier = deps.notifier ?? new TelegramNotificationProvider(telegram, logger.child({ module: 'notify' }));
  const backupDestination = deps.backupDestination ?? new TelegramBackupDestination(telegram, logger.child({ module: 'delivery' }));

  const audit = new AuditService(db, logger.child({ module: 'audit' }));
  const users = new UsersService(db, config);
  const credentials = new CredentialsService(db);
  const destinations = new DestinationsService(db, telegram, logger.child({ module: 'destinations' }));
  const health = new HealthService(db, notifier, logger.child({ module: 'health' }), deps.now);
  const monitors = new MonitorsService(db, config, settings, health);
  const services = new ServicesService(db, config, limits, limiter, credentials, destinations, monitors);
  const backups = new BackupsService(db, backupDestination, notifier, logger.child({ module: 'backups' }));
  const stats = new StatsService(db);
  const backupQueue = new BackupQueue(backups, config.backupConcurrency, logger.child({ module: 'queue' }));
  const healthMonitor = new HealthMonitor(health, config.healthCheckIntervalSeconds, logger.child({ module: 'monitor' }));

  return {
    config,
    db,
    logger,
    telegram,
    limiter,
    settings,
    limits,
    notifier,
    audit,
    users,
    credentials,
    destinations,
    health,
    monitors,
    services,
    backups,
    stats,
    backupQueue,
    healthMonitor,
  };
}

export type AppContext = ReturnType<typeof createContext>;
