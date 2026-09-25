import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import type { Db } from '../database/client.js';
import { settings } from '../database/schema.js';
import { isValidRateLimit } from '../rate-limit/rate-limit.js';

const rateLimitString = z.string().trim().max(32).refine(isValidRateLimit, 'Invalid rate limit (e.g. "60/minute")');

export const defaultLimitsSchema = z.object({
  apiRateLimit: rateLimitString,
  backupRateLimit: rateLimitString,
  heartbeatRateLimit: rateLimitString,
  serviceCreateRateLimit: rateLimitString,
  maxBackupSizeMb: z.number().int().min(1).max(4000),
  maxServicesPerUser: z.number().int().min(0).max(10_000),
  maxMonitorsPerService: z.number().int().min(1).max(1000),
});

export type DefaultLimits = z.infer<typeof defaultLimitsSchema>;

const LIMITS_KEY = 'default_limits';

/**
 * Admin-editable defaults. Environment variables provide the initial values; admin changes are
 * stored in the `settings` table and override them. Values are cached in memory.
 */
export class SettingsService {
  private cached: DefaultLimits | undefined;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  envDefaults(): DefaultLimits {
    const d = this.config.defaults;
    return {
      apiRateLimit: d.apiRateLimit,
      backupRateLimit: d.backupRateLimit,
      heartbeatRateLimit: d.heartbeatRateLimit,
      serviceCreateRateLimit: d.serviceCreateRateLimit,
      maxBackupSizeMb: d.maxBackupSizeMb,
      maxServicesPerUser: d.maxServicesPerUser,
      maxMonitorsPerService: d.maxMonitorsPerService,
    };
  }

  getDefaultLimits(): DefaultLimits {
    if (this.cached) return this.cached;
    const row = this.db.select().from(settings).where(eq(settings.key, LIMITS_KEY)).get();
    const stored = defaultLimitsSchema.partial().safeParse(row?.value ?? {});
    this.cached = { ...this.envDefaults(), ...(stored.success ? stored.data : {}) };
    return this.cached;
  }

  updateDefaultLimits(patch: Partial<DefaultLimits>): DefaultLimits {
    const next = defaultLimitsSchema.parse({ ...this.getDefaultLimits(), ...patch });
    this.db
      .insert(settings)
      .values({ key: LIMITS_KEY, value: next })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
      .run();
    this.cached = next;
    return next;
  }

  resetDefaultLimits(): DefaultLimits {
    this.db.delete(settings).where(eq(settings.key, LIMITS_KEY)).run();
    this.cached = undefined;
    return this.getDefaultLimits();
  }
}
