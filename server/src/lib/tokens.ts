import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'gyb_';
const TOKEN_PATTERN = /^gyb_[A-Za-z0-9_-]{43}$/;

export interface GeneratedToken {
  token: string;
  hash: string;
  prefix: string;
}

/** 32 random bytes → 256 bits of entropy. SHA-256 is sufficient for hashing high-entropy secrets. */
export function generateToken(): GeneratedToken {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), prefix: displayPrefix(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** Safe-to-log/display fragment of a token, e.g. `gyb_AbCd1234…`. */
export function displayPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 8);
}
