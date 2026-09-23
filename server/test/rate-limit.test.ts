import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRateLimit, RateLimiter } from '../src/rate-limit/rate-limit.js';
import { bearer, createHarness, createService, createUser, multipart, sessionHeaders, type TestHarness } from './helpers.js';

describe('parseRateLimit', () => {
  it('parses common formats', () => {
    expect(parseRateLimit('60/minute')).toEqual({ max: 60, windowMs: 60_000 });
    expect(parseRateLimit('30/hour')).toEqual({ max: 30, windowMs: 3_600_000 });
    expect(parseRateLimit('100/15m')).toEqual({ max: 100, windowMs: 900_000 });
    expect(parseRateLimit('5/seconds')).toEqual({ max: 5, windowMs: 5_000 / 5 });
    expect(parseRateLimit('30', 'hour')).toEqual({ max: 30, windowMs: 3_600_000 });
    expect(parseRateLimit('unlimited')).toBeNull();
    expect(() => parseRateLimit('lots')).toThrow();
  });

  it('does not consume other buckets when one rejects', () => {
    const limiter = new RateLimiter();
    const a = { key: 'a', limit: { max: 1, windowMs: 60_000 } };
    const b = { key: 'b', limit: { max: 5, windowMs: 60_000 } };
    expect(limiter.consume([a, b]).allowed).toBe(true);
    expect(limiter.consume([a, b]).allowed).toBe(false);
    expect(limiter.consume([b]).remaining).toBe(3);
  });
});

describe('HTTP rate limiting', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await createHarness({ DEFAULT_API_RATE_LIMIT: '5/minute', DEFAULT_BACKUP_RATE_LIMIT: '2/hour', DEFAULT_HEARTBEAT_RATE_LIMIT: '3/minute' });
  });
  afterEach(async () => {
    await h.close();
  });

  const upload = (token: string) => {
    const form = multipart('a.db', 'data');
    return h.app.inject({ method: 'POST', url: '/api/v1/backups', headers: { ...bearer(token), ...form.headers }, payload: form.payload });
  };
  const info = (token: string) => h.app.inject({ method: 'GET', url: '/api/v1/service', headers: bearer(token) });

  it('enforces the API rate limit with headers', async () => {
    const { token } = createService(h, createUser(h));
    for (let i = 0; i < 5; i++) expect((await info(token)).statusCode).toBe(200);
    const res = await info(token);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBe('0');

    h.clock.advance(61_000);
    expect((await info(token)).statusCode).toBe(200);
  });

  it('enforces the backup rate limit', async () => {
    const { token } = createService(h, createUser(h));
    expect((await upload(token)).statusCode).toBe(202);
    expect((await upload(token)).statusCode).toBe(202);
    const res = await upload(token);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toMatch(/Backup rate limit/);
  });

  it('aggregates limits per user so extra services do not add quota', async () => {
    const user = createUser(h);
    const a = createService(h, user, { name: 'A' });
    const b = createService(h, user, { name: 'B' });
    expect((await upload(a.token)).statusCode).toBe(202);
    expect((await upload(b.token)).statusCode).toBe(202);
    expect((await upload(b.token)).statusCode).toBe(429);

    // Another user is unaffected.
    const other = createService(h, createUser(h));
    expect((await upload(other.token)).statusCode).toBe(202);
  });

  it('applies per-service limit overrides', async () => {
    const user = createUser(h);
    const a = createService(h, user, { name: 'A' });
    const b = createService(h, user, { name: 'B' });
    h.ctx.services.adminSetLimits(a.service.id, { apiRateLimit: '1/minute' });
    expect((await info(a.token)).statusCode).toBe(200);
    expect((await info(a.token)).statusCode).toBe(429);
    expect((await info(b.token)).statusCode).toBe(200);
  });

  it('applies per-user limit overrides', async () => {
    const user = createUser(h);
    h.ctx.users.updateLimits(user.id, { backupRateLimit: '1/hour' });
    const { token } = createService(h, h.ctx.users.getById(user.id)!);
    expect((await upload(token)).statusCode).toBe(202);
    expect((await upload(token)).statusCode).toBe(429);
  });

  it('limits heartbeats per service', async () => {
    const { token } = createService(h, createUser(h), { healthEnabled: true });
    const beat = () => h.app.inject({ method: 'POST', url: '/api/v1/health/heartbeat', headers: bearer(token) });
    for (let i = 0; i < 3; i++) expect((await beat()).statusCode).toBe(200);
    expect((await beat()).statusCode).toBe(429);
  });

  it('enforces the maximum services per user', async () => {
    const user = createUser(h);
    h.ctx.users.updateLimits(user.id, { maxServices: 2 });
    const headers = sessionHeaders(h, user);
    const create = (name: string) => h.app.inject({ method: 'POST', url: '/api/v1/app/services', headers, payload: { name } });
    expect((await create('one')).statusCode).toBe(201);
    expect((await create('two')).statusCode).toBe(201);
    const third = await create('three');
    expect(third.statusCode).toBe(403);
    expect(third.json().error.code).toBe('LIMIT_EXCEEDED');
  });

  it('lets admins change default limits at runtime', async () => {
    const { token } = createService(h, createUser(h));
    h.ctx.settings.updateDefaultLimits({ apiRateLimit: '1/minute' });
    expect((await info(token)).statusCode).toBe(200);
    expect((await info(token)).statusCode).toBe(429);
  });
});

describe('effective max backup size', () => {
  it('is the smaller of the configured size and the Telegram cap', async () => {
    const official = await createHarness({ MAX_BACKUP_SIZE_MB: '1024' });
    expect(official.ctx.limits.forUser(createUser(official)).maxBackupBytes).toBe(50 * 1024 * 1024);
    await official.close();

    const local = await createHarness({ MAX_BACKUP_SIZE_MB: '1024', TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081' });
    expect(local.ctx.limits.forUser(createUser(local)).maxBackupBytes).toBe(1024 * 1024 * 1024);
    await local.close();
  });
});
