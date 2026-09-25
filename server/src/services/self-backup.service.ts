import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import type { Db } from '../database/client.js';
import { backups, monitors, services, users, type User } from '../database/schema.js';
import { AppError } from '../lib/errors.js';
import { resolveInside } from '../lib/filenames.js';
import { escapeHtml, formatBytes, formatUtc } from '../lib/format.js';
import { newId } from '../lib/ids.js';
import { TelegramApiError, type TelegramGateway } from '../telegram/gateway.js';
import type { SettingsService } from './settings.service.js';

/** Allowed schedule intervals, in hours. */
export const SELF_BACKUP_INTERVALS = [1, 6, 12, 24, 168] as const;

export const selfBackupConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z
    .number()
    .int()
    .refine((h) => (SELF_BACKUP_INTERVALS as readonly number[]).includes(h), `One of ${SELF_BACKUP_INTERVALS.join(', ')} hours`),
});

interface StoredConfig {
  enabled: boolean;
  intervalHours: number;
  /** Private chat of the admin who configured it; the database is only ever sent there. */
  recipientTelegramId: number | null;
  recipientName: string | null;
}

interface StoredState {
  lastRunAt: string | null;
  lastStatus: 'SUCCESS' | 'FAILED' | null;
  lastError: string | null;
  lastSizeBytes: number | null;
  lastParts: number | null;
  lastTrigger: 'schedule' | 'manual' | null;
}

const CONFIG_KEY = 'self_backup_config';
const STATE_KEY = 'self_backup_state';
const HOUR_MS = 3_600_000;
const MAX_ATTEMPTS = 3;

const DEFAULT_CONFIG: StoredConfig = { enabled: false, intervalHours: 24, recipientTelegramId: null, recipientName: null };
const EMPTY_STATE: StoredState = { lastRunAt: null, lastStatus: null, lastError: null, lastSizeBytes: null, lastParts: null, lastTrigger: null };

/**
 * Backs up GotYouBro's own SQLite database to the administrator's private Telegram chat on a
 * schedule the admin sets in the Web App. The snapshot uses SQLite's online backup API (consistent
 * while the app keeps running), is gzipped, split only if it exceeds Telegram's file limit, and all
 * temporary files are deleted afterwards. Nothing is kept on the server.
 */
export class SelfBackupService {
  private running: Promise<StoredState> | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly settings: SettingsService,
    private readonly telegram: TelegramGateway,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private getConfig(): StoredConfig {
    return { ...DEFAULT_CONFIG, ...this.settings.getValue<StoredConfig>(CONFIG_KEY) };
  }

  private getState(): StoredState {
    return { ...EMPTY_STATE, ...this.settings.getValue<StoredState>(STATE_KEY) };
  }

  status() {
    const config = this.getConfig();
    const state = this.getState();
    return {
      ...config,
      ...state,
      running: this.running !== null,
      intervals: SELF_BACKUP_INTERVALS,
      nextRunAt: config.enabled && config.recipientTelegramId ? new Date(this.nextRunTime(config, state)) : null,
    };
  }

  /** Save the schedule. The admin who saves it becomes the recipient. */
  configure(admin: User, input: z.infer<typeof selfBackupConfigSchema>) {
    const next: StoredConfig = {
      enabled: input.enabled,
      intervalHours: input.intervalHours,
      recipientTelegramId: admin.telegramId,
      recipientName: admin.username ? `@${admin.username}` : (admin.firstName ?? String(admin.telegramId)),
    };
    this.settings.setValue(CONFIG_KEY, next);
    return this.status();
  }

  isDue(): boolean {
    const config = this.getConfig();
    if (!config.enabled || !config.recipientTelegramId || this.running) return false;
    return this.now().getTime() >= this.nextRunTime(config, this.getState());
  }

  /** Run now (or join a run that is already in progress). */
  run(trigger: 'schedule' | 'manual'): Promise<StoredState> {
    const config = this.getConfig();
    if (!config.recipientTelegramId) {
      throw new AppError('VALIDATION_ERROR', 'Save the database backup settings first, so GotYouBro knows which admin to send it to');
    }
    this.running ??= this.execute(config.recipientTelegramId, trigger).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private nextRunTime(config: StoredConfig, state: StoredState): number {
    // Never run yet → due now; afterwards every intervalHours after the last attempt.
    return state.lastRunAt ? new Date(state.lastRunAt).getTime() + config.intervalHours * HOUR_MS : this.now().getTime();
  }

  private async execute(chatId: number, trigger: 'schedule' | 'manual'): Promise<StoredState> {
    const startedAt = this.now();
    const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const baseName = `gotyoubro-${stamp}.sqlite.gz`;
    await fs.mkdir(this.config.tmpDir, { recursive: true });
    const snapshot = resolveInside(this.config.tmpDir, `self-${newId()}.sqlite`);
    const gz = resolveInside(this.config.tmpDir, `self-${newId()}.gz`);
    const files: string[] = [snapshot, gz];

    let state: StoredState;
    try {
      await this.db.$client.backup(snapshot);
      await pipeline(createReadStream(snapshot), createGzip({ level: 9 }), createWriteStream(gz, { mode: 0o600 }));
      const size = (await fs.stat(gz)).size;

      const parts = await this.split(gz, size, files);
      const counts = this.counts();
      for (const [i, part] of parts.entries()) {
        const filename = parts.length === 1 ? baseName : `${baseName}.part${String(i + 1).padStart(3, '0')}`;
        const caption = [
          '🗄 <b>GotYouBro database backup</b>',
          '',
          `Created: ${formatUtc(startedAt)}`,
          `Size: ${formatBytes(size)}${parts.length > 1 ? ` · part ${i + 1}/${parts.length}` : ''}`,
          `Users: ${counts.users} · Services: ${counts.services} · Monitors: ${counts.monitors} · Backups: ${counts.backups}`,
          '',
          escapeHtml(parts.length > 1 ? 'Restore: cat the parts together, then gunzip.' : 'Restore: gunzip, then use it as DATABASE_URL.'),
        ].join('\n');
        await this.send(chatId, part, filename, caption);
      }
      state = {
        lastRunAt: startedAt.toISOString(),
        lastStatus: 'SUCCESS',
        lastError: null,
        lastSizeBytes: size,
        lastParts: parts.length,
        lastTrigger: trigger,
      };
      this.logger.info({ size, parts: parts.length, trigger }, 'Database backup sent to admin');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: reason, trigger }, 'Database backup failed');
      state = { ...this.getState(), lastRunAt: startedAt.toISOString(), lastStatus: 'FAILED', lastError: reason.slice(0, 300), lastTrigger: trigger };
      await this.telegram.sendMessage(chatId, `⚠️ GotYouBro database backup failed: ${reason.slice(0, 300)}`).catch(() => undefined);
    } finally {
      await Promise.all(files.map((f) => fs.rm(f, { force: true }).catch(() => undefined)));
    }
    this.settings.setValue(STATE_KEY, state);
    return state;
  }

  /** Split into parts that fit Telegram's upload limit (usually a single part). */
  private async split(file: string, size: number, cleanup: string[]): Promise<string[]> {
    const partSize = Math.floor(this.config.telegram.maxFileBytes * 0.95);
    if (size <= partSize) return [file];
    const parts: string[] = [];
    for (let start = 0, i = 1; start < size; start += partSize, i++) {
      const part = resolveInside(this.config.tmpDir, `self-${newId()}.part${i}`);
      cleanup.push(part);
      await pipeline(createReadStream(file, { start, end: Math.min(size, start + partSize) - 1 }), createWriteStream(part, { mode: 0o600 }));
      parts.push(part);
    }
    return parts;
  }

  private async send(chatId: number, path: string, filename: string, caption: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.telegram.sendDocument(chatId, { path, filename }, { caption, html: true });
        return;
      } catch (err) {
        const retryable = err instanceof TelegramApiError && err.retryable;
        if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
        await sleep(err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 2000 * attempt);
      }
    }
  }

  private counts() {
    const n = sql<number>`count(*)`;
    const count = (table: typeof users | typeof services | typeof monitors | typeof backups) => this.db.select({ n }).from(table).get()?.n ?? 0;
    return { users: count(users), services: count(services), monitors: count(monitors), backups: count(backups) };
  }
}
