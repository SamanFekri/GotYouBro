import type { AppConfig } from '../config/index.js';
import type { Service, User } from '../database/schema.js';
import type { SettingsService } from '../services/settings.service.js';
import { parseRateLimit, type RateLimit, type RateLimitCheck } from './rate-limit.js';

export type LimitCategory = 'api' | 'backup' | 'heartbeat';

export interface EffectiveLimits {
  apiRateLimit: string;
  backupRateLimit: string;
  heartbeatRateLimit: string;
  serviceCreateRateLimit: string;
  maxBackupSizeMb: number;
  maxBackupBytes: number;
  maxServices: number;
}

/**
 * Resolves the limits that apply to a user / service and builds rate-limit bucket checks.
 *
 * Precedence: per-service override → per-user override → admin default → env default.
 *
 * API and backup limits are enforced per *user* (aggregated over all of the user's services), so
 * creating more services never increases a user's quota. A per-service override adds an extra
 * bucket for that service. Heartbeats are limited per service (their volume is bounded by the
 * per-user service cap). A service has exactly one active credential, so service-level buckets
 * double as credential-level buckets (and survive token rotation).
 */
export class LimitsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
  ) {}

  forUser(user: Pick<User, 'maxServices' | 'maxBackupSizeMb' | 'apiRateLimit' | 'backupRateLimit'>, service?: Service): EffectiveLimits {
    const defaults = this.settings.getDefaultLimits();
    const maxBackupSizeMb = service?.maxBackupSizeMb ?? user.maxBackupSizeMb ?? defaults.maxBackupSizeMb;
    return {
      apiRateLimit: user.apiRateLimit ?? defaults.apiRateLimit,
      backupRateLimit: user.backupRateLimit ?? defaults.backupRateLimit,
      heartbeatRateLimit: service?.heartbeatRateLimit ?? defaults.heartbeatRateLimit,
      serviceCreateRateLimit: defaults.serviceCreateRateLimit,
      maxBackupSizeMb,
      // Never exceed what the Telegram Bot API can actually deliver.
      maxBackupBytes: Math.min(maxBackupSizeMb * 1024 * 1024, this.config.telegram.maxFileBytes),
      maxServices: user.maxServices ?? defaults.maxServicesPerUser,
    };
  }

  /** Bucket checks for a service-authenticated API request. */
  serviceApiChecks(user: User, service: Service, category: LimitCategory): RateLimitCheck[] {
    const limits = this.forUser(user, service);
    const perMinute = (s: string) => parseRateLimit(s, 'minute');
    const perHour = (s: string) => parseRateLimit(s, 'hour');
    const checks: RateLimitCheck[] = [];

    if (category === 'heartbeat') {
      checks.push({ key: `service:${service.id}:heartbeat`, limit: perMinute(limits.heartbeatRateLimit) });
      return checks;
    }

    checks.push({ key: `user:${user.id}:api`, limit: perMinute(limits.apiRateLimit) });
    if (service.apiRateLimit) checks.push({ key: `service:${service.id}:api`, limit: perMinute(service.apiRateLimit) });

    if (category === 'backup') {
      checks.push({ key: `user:${user.id}:backup`, limit: perHour(limits.backupRateLimit) });
      if (service.backupRateLimit) checks.push({ key: `service:${service.id}:backup`, limit: perHour(service.backupRateLimit) });
    }
    return checks;
  }

  serviceCreateCheck(user: User): RateLimitCheck {
    return { key: `user:${user.id}:service-create`, limit: parseRateLimit(this.forUser(user).serviceCreateRateLimit, 'hour') };
  }

  ipCheck(ip: string): RateLimitCheck {
    return { key: `ip:${ip}`, limit: parseRateLimit(this.config.defaults.ipRateLimit, 'minute') };
  }

  webappCheck(userId: string): RateLimitCheck {
    return { key: `user:${userId}:webapp`, limit: parseRateLimit(this.config.defaults.webappRateLimit, 'minute') };
  }
}

export type { RateLimit };
