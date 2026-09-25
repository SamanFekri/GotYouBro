import type { Logger } from 'pino';
import type { HealthService } from '../services/health.service.js';

/** Periodic in-process timer that marks overdue services DOWN. One cheap indexed query per tick. */
export class HealthMonitor {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly health: HealthService,
    private readonly intervalSeconds: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), this.intervalSeconds * 1000);
    this.timer.unref();
    this.logger.info({ intervalSeconds: this.intervalSeconds }, 'Health monitor started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private lastPrune = 0;

  tick(): number {
    try {
      // Retention runs at most once an hour; it is a single indexed DELETE.
      if (Date.now() - this.lastPrune > 3_600_000) {
        this.lastPrune = Date.now();
        this.health.prune();
      }
      return this.health.checkOverdue();
    } catch (err) {
      this.logger.error({ err }, 'Health check tick failed');
      return 0;
    }
  }
}
