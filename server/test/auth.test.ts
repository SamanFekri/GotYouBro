import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signInitData, validateInitData } from '../src/auth/telegram-init-data.js';
import { BOT_TOKEN, bearer, createHarness, createService, createUser, type TestHarness } from './helpers.js';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const heartbeat = (token: string) => h.app.inject({ method: 'POST', url: '/api/v1/health/heartbeat', headers: bearer(token) });

describe('service token authentication', () => {
  it('accepts a valid token', async () => {
    const { service, token } = createService(h, createUser(h), { healthEnabled: true });
    const res = await heartbeat(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, data: { serviceId: service.id, healthStatus: 'HEALTHY' } });
  });

  it('rejects a missing token', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/health/heartbeat' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an invalid token', async () => {
    const res = await heartbeat('gyb_' + 'x'.repeat(43));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid API token' } });
  });

  it('rejects a malformed token', async () => {
    const res = await heartbeat('not-a-token');
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('rejects a revoked token', async () => {
    const { service, token } = createService(h, createUser(h));
    h.ctx.credentials.revoke(service.id);
    const res = await heartbeat(token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TOKEN_REVOKED');
  });

  it('rejects the old token after rotation and accepts the new one', async () => {
    const { service, token } = createService(h, createUser(h));
    const { token: next } = h.ctx.credentials.issue(service.id);
    expect((await heartbeat(token)).json().error.code).toBe('TOKEN_REVOKED');
    expect((await heartbeat(next)).statusCode).toBe(200);
  });

  it('rejects tokens of blocked users', async () => {
    const user = createUser(h);
    const { token } = createService(h, user);
    h.ctx.users.setBlocked(user, true, 'abuse');
    const res = await heartbeat(token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('USER_BLOCKED');
  });

  it('rejects disabled and suspended services', async () => {
    const user = createUser(h);
    const { service, token } = createService(h, user);
    h.ctx.services.update(user, service.id, { status: 'DISABLED' });
    expect((await heartbeat(token)).json().error.code).toBe('SERVICE_DISABLED');
    h.ctx.services.adminSetStatus(service.id, 'SUSPENDED');
    expect((await heartbeat(token)).json().error.code).toBe('SERVICE_DISABLED');
  });

  it('stores only a hash of the token', async () => {
    const { token } = createService(h, createUser(h));
    const rows = h.ctx.db.$client.prepare('SELECT token_hash, token_prefix FROM api_credentials').all() as Array<{ token_hash: string; token_prefix: string }>;
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
    expect(token.startsWith(rows[0]!.token_prefix)).toBe(true);
  });
});

describe('Telegram Web App authentication', () => {
  const initData = (user: object, authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN) =>
    signInitData({ auth_date: String(authDate), query_id: 'AAE', user: JSON.stringify(user) }, token);

  it('validates initData and issues a session', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/app/auth', payload: { initData: initData({ id: 777, first_name: 'Ann' }) } });
    expect(res.statusCode).toBe(200);
    const { token, user } = res.json().data;
    expect(user).toMatchObject({ telegramId: 777, isAdmin: false });

    const me = await h.app.inject({ method: 'GET', url: '/api/v1/app/me', headers: bearer(token) });
    expect(me.json().data.telegramId).toBe(777);
  });

  it('grants admin only to ADMIN_TELEGRAM_ID', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/app/auth', payload: { initData: initData({ id: 1000, first_name: 'Root' }) } });
    expect(res.json().data.user).toMatchObject({ isAdmin: true, isRootAdmin: true });
  });

  it('rejects initData signed with another bot token', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/app/auth', payload: { initData: initData({ id: 777 }, undefined, '999:other') } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects tampered initData', async () => {
    const tampered = initData({ id: 777 }).replace('777', '1000');
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/app/auth', payload: { initData: tampered } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects expired initData', () => {
    const old = initData({ id: 777 }, Math.floor(Date.now() / 1000) - 90_000);
    expect(() => validateInitData(old, BOT_TOKEN, 86_400)).toThrow(/expired/);
  });

  it('rejects blocked users at login and on existing sessions', async () => {
    const login = await h.app.inject({ method: 'POST', url: '/api/v1/app/auth', payload: { initData: initData({ id: 778 }) } });
    const token = login.json().data.token;
    h.ctx.users.setBlocked(h.ctx.users.getByTelegramId(778)!, true);

    const me = await h.app.inject({ method: 'GET', url: '/api/v1/app/me', headers: bearer(token) });
    expect(me.statusCode).toBe(403);
    expect(me.json().error.code).toBe('USER_BLOCKED');

    const again = await h.app.inject({ method: 'POST', url: '/api/v1/app/auth', payload: { initData: initData({ id: 778 }) } });
    expect(again.json().error.code).toBe('USER_BLOCKED');
  });

  it('rejects requests without a session', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/app/services' });
    expect(res.statusCode).toBe(401);
  });
});
