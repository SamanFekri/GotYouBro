import path from 'node:path';
import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalInt = (fallback: number) => z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(fallback));
const bool = (fallback: boolean) =>
  z.preprocess(emptyToUndefined, z.enum(['true', 'false', '1', '0']).default(fallback ? 'true' : 'false')).transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: optionalInt(6969),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().default('file:./data/gotyoubro.db'),
  DATA_DIR: optionalString,

  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_API_ROOT: optionalString,
  /** Defaults to 50 (official Bot API) or 2000 when TELEGRAM_API_ROOT points to a local Bot API server. */
  TELEGRAM_MAX_FILE_MB: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  BOT_ENABLED: bool(true),
  ADMIN_TELEGRAM_ID: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),

  WEBAPP_URL: optionalString,
  WEBAPP_DIST: optionalString,
  PUBLIC_API_URL: optionalString,
  CORS_ORIGINS: optionalString,
  TRUST_PROXY: bool(false),

  JWT_SECRET: optionalString,
  JWT_EXPIRES_IN: z.string().default('12h'),
  INIT_DATA_MAX_AGE_SECONDS: optionalInt(86400),

  MAX_BACKUP_SIZE_MB: optionalInt(1536),
  MAX_SERVICES_PER_USER: optionalInt(10),
  DEFAULT_API_RATE_LIMIT: z.string().default('60/minute'),
  DEFAULT_BACKUP_RATE_LIMIT: z.string().default('30/hour'),
  DEFAULT_HEARTBEAT_RATE_LIMIT: z.string().default('10/minute'),
  DEFAULT_SERVICE_CREATE_RATE_LIMIT: z.string().default('10/hour'),
  IP_RATE_LIMIT: z.string().default('300/minute'),
  WEBAPP_RATE_LIMIT: z.string().default('120/minute'),

  HEALTH_CHECK_INTERVAL_SECONDS: optionalInt(30),
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS: optionalInt(60),
  DEFAULT_HEARTBEAT_GRACE_SECONDS: optionalInt(60),

  BACKUP_CONCURRENCY: optionalInt(2),
  BACKUP_WAIT_TIMEOUT_SECONDS: optionalInt(600),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  databaseFile: string;
  dataDir: string;
  tmpDir: string;
  telegram: {
    botToken: string | undefined;
    apiRoot: string | undefined;
    maxFileBytes: number;
    botEnabled: boolean;
  };
  adminTelegramId: number | undefined;
  webappUrl: string | undefined;
  webappDist: string | undefined;
  publicApiUrl: string | undefined;
  corsOrigins: string[];
  trustProxy: boolean;
  jwt: { secret: string; expiresIn: string };
  initDataMaxAgeSeconds: number;
  defaults: {
    maxBackupSizeMb: number;
    maxServicesPerUser: number;
    apiRateLimit: string;
    backupRateLimit: string;
    heartbeatRateLimit: string;
    serviceCreateRateLimit: string;
    ipRateLimit: string;
    webappRateLimit: string;
    heartbeatIntervalSeconds: number;
    heartbeatGraceSeconds: number;
  };
  healthCheckIntervalSeconds: number;
  backupConcurrency: number;
  backupWaitTimeoutSeconds: number;
}

/** Resolve `file:./data/x.db` (Prisma-style) or a plain path to an absolute file path. */
function resolveDatabaseFile(url: string): string {
  if (url === ':memory:' || url === 'file::memory:') return ':memory:';
  const raw = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return path.resolve(process.cwd(), raw);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction) {
    const missing = (['TELEGRAM_BOT_TOKEN', 'JWT_SECRET', 'WEBAPP_URL'] as const).filter((k) => !env[k]);
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    if ((env.JWT_SECRET ?? '').length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  }

  const databaseFile = resolveDatabaseFile(env.DATABASE_URL);
  const dataDir = path.resolve(env.DATA_DIR ?? (databaseFile === ':memory:' ? './data' : path.dirname(databaseFile)));

  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (!corsOrigins.length && env.WEBAPP_URL) corsOrigins.push(new URL(env.WEBAPP_URL).origin);

  return {
    env: env.NODE_ENV,
    isProduction,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseFile,
    dataDir,
    tmpDir: path.join(dataDir, 'tmp'),
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      apiRoot: env.TELEGRAM_API_ROOT,
      maxFileBytes: (env.TELEGRAM_MAX_FILE_MB ?? (env.TELEGRAM_API_ROOT ? 2000 : 50)) * 1024 * 1024,
      botEnabled: env.BOT_ENABLED,
    },
    adminTelegramId: env.ADMIN_TELEGRAM_ID,
    webappUrl: env.WEBAPP_URL,
    webappDist: env.WEBAPP_DIST,
    publicApiUrl: env.PUBLIC_API_URL ?? env.WEBAPP_URL,
    corsOrigins,
    trustProxy: env.TRUST_PROXY,
    // A random per-process secret is acceptable in development: sessions simply reset on restart.
    jwt: { secret: env.JWT_SECRET ?? cryptoRandomSecret(), expiresIn: env.JWT_EXPIRES_IN },
    initDataMaxAgeSeconds: env.INIT_DATA_MAX_AGE_SECONDS,
    defaults: {
      maxBackupSizeMb: env.MAX_BACKUP_SIZE_MB,
      maxServicesPerUser: env.MAX_SERVICES_PER_USER,
      apiRateLimit: env.DEFAULT_API_RATE_LIMIT,
      backupRateLimit: env.DEFAULT_BACKUP_RATE_LIMIT,
      heartbeatRateLimit: env.DEFAULT_HEARTBEAT_RATE_LIMIT,
      serviceCreateRateLimit: env.DEFAULT_SERVICE_CREATE_RATE_LIMIT,
      ipRateLimit: env.IP_RATE_LIMIT,
      webappRateLimit: env.WEBAPP_RATE_LIMIT,
      heartbeatIntervalSeconds: env.DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
      heartbeatGraceSeconds: env.DEFAULT_HEARTBEAT_GRACE_SECONDS,
    },
    healthCheckIntervalSeconds: env.HEALTH_CHECK_INTERVAL_SECONDS,
    backupConcurrency: env.BACKUP_CONCURRENCY,
    backupWaitTimeoutSeconds: env.BACKUP_WAIT_TIMEOUT_SECONDS,
  };
}

function cryptoRandomSecret(): string {
  return globalThis.crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}
