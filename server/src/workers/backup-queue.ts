import type { Logger } from 'pino';
import type { Backup } from '../database/schema.js';
import type { BackupsService } from '../services/backups.service.js';

interface Job {
  backupId: string;
  filePath: string;
  resolve: (backup: Backup) => void;
}

/**
 * Tiny in-process job queue with bounded concurrency. No external broker: backups that are in
 * flight during a restart are marked FAILED (INTERRUPTED) on the next startup.
 */
export class BackupQueue {
  private readonly pending: Job[] = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly backupsService: BackupsService,
    private readonly concurrency: number,
    private readonly logger: Logger,
  ) {}

  /** Queue a backup for delivery; the promise resolves with the final record (never rejects). */
  enqueue(backupId: string, filePath: string): Promise<Backup> {
    return new Promise((resolve) => {
      this.pending.push({ backupId, filePath, resolve });
      this.pump();
    });
  }

  get size(): { pending: number; running: number } {
    return { pending: this.pending.length, running: this.running };
  }

  /** Resolves once nothing is pending or running (used for graceful shutdown and tests). */
  onIdle(): Promise<void> {
    if (!this.running && !this.pending.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      this.running++;
      this.backupsService
        .process(job.backupId, job.filePath)
        .then(job.resolve, (err) => this.logger.error({ err, backupId: job.backupId }, 'Unexpected queue failure'))
        .finally(() => {
          this.running--;
          this.pump();
          if (!this.running && !this.pending.length) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach((w) => w());
          }
        });
    }
  }
}
