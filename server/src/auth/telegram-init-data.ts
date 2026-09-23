import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { TelegramProfile } from '../services/users.service.js';

const telegramUserSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  is_bot: z.boolean().optional(),
});

export class InitDataError extends Error {}

/**
 * Validate Telegram Web App `initData` as documented at
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 *   secret_key = HMAC_SHA256(key = "WebAppData", data = bot_token)
 *   hash       = hex(HMAC_SHA256(key = secret_key, data = data_check_string))
 *
 * where data_check_string is every received field except `hash`, sorted by key, as `key=value`
 * joined with "\n". The Telegram user identity is taken only from this signed payload.
 */
export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  nowMs: number = Date.now(),
): { user: TelegramProfile; authDate: Date } {
  if (!initData || initData.length > 4096) throw new InitDataError('initData missing or too long');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new InitDataError('initData hash missing');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  const received = Buffer.from(hash, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new InitDataError('initData signature is invalid');
  }

  const authDateSeconds = Number(params.get('auth_date'));
  if (!Number.isFinite(authDateSeconds) || authDateSeconds <= 0) throw new InitDataError('auth_date missing');
  const ageSeconds = nowMs / 1000 - authDateSeconds;
  if (ageSeconds > maxAgeSeconds) throw new InitDataError('initData has expired');
  if (ageSeconds < -300) throw new InitDataError('auth_date is in the future');

  let rawUser: unknown;
  try {
    rawUser = JSON.parse(params.get('user') ?? 'null');
  } catch {
    throw new InitDataError('initData user is malformed');
  }
  const user = telegramUserSchema.safeParse(rawUser);
  if (!user.success || user.data.is_bot) throw new InitDataError('initData user is invalid');

  return { user: user.data, authDate: new Date(authDateSeconds * 1000) };
}

/** Build signed initData (used by tests and local tooling). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
