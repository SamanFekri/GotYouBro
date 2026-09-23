import pino, { type Logger } from 'pino';
import type { AppConfig } from '../config/index.js';

/** Never log secrets: tokens, session JWTs, initData or the bot token. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'authorization',
  'token',
  '*.token',
  'initData',
  '*.initData',
  'botToken',
];

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'isProduction' | 'env'>): Logger {
  const pretty = !config.isProduction && config.env !== 'test' && process.stdout.isTTY;
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(pretty && { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
  });
}
