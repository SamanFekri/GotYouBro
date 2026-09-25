import type { Logger } from 'pino';
import type { SelfBackupService } from '../services/self-backup.service.js';

/** Checks once a minute whether the admin-scheduled database backup is due. */
export class SelfBackupScheduler {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly selfBackup: SelfBackupService,
    private readonly logger: Logger,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    try {
      if (this.selfBackup.isDue()) {
        this.selfBackup.run('schedule').catch((err) => this.logger.error({ err }, 'Scheduled database backup crashed'));
      }
    } catch (err) {
      this.logger.error({ err }, 'Database backup scheduler tick failed');
    }
  }
}
