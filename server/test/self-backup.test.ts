import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TELEGRAM_ID, createHarness, createService, createUser, sessionHeaders, type TestHarness } from './helpers.js';

const HOUR = 3_600_000;

describe('GotYouBro database backup to the admin', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  const call = (method: 'GET' | 'PUT' | 'POST', url: string, user: ReturnType<typeof createUser>, payload?: unknown) =>
    h.app.inject({ method, url: `/api/v1/admin${url}`, headers: sessionHeaders(h, user), payload: payload as object });

  it('is admin-only', async () => {
    const user = createUser(h);
    expect((await call('GET', '/self-backup', user)).statusCode).toBe(403);
    expect((await call('PUT', '/self-backup', user, { enabled: true, intervalHours: 24 })).statusCode).toBe(403);
    expect((await call('POST', '/self-backup/run', user)).statusCode).toBe(403);
  });

  it('refuses to run before it is configured', async () => {
    const admin = createUser(h, ADMIN_TELEGRAM_ID);
    expect((await call('POST', '/self-backup/run', admin)).statusCode).toBe(400);
    expect(h.telegram.documents).toHaveLength(0);
  });

  it('validates the interval', async () => {
    const admin = createUser(h, ADMIN_TELEGRAM_ID);
    expect((await call('PUT', '/self-backup', admin, { enabled: true, intervalHours: 5 })).statusCode).toBe(400);
  });

  it('sends a gzipped SQLite snapshot to the admin private chat', async () => {
    const admin = createUser(h, ADMIN_TELEGRAM_ID);
    createService(h, createUser(h), { name: 'Shop' });
    expect((await call('PUT', '/self-backup', admin, { enabled: false, intervalHours: 24 })).statusCode).toBe(200);

    const res = await call('POST', '/self-backup/run', admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ lastStatus: 'SUCCESS', lastParts: 1, lastTrigger: 'manual', recipientTelegramId: ADMIN_TELEGRAM_ID });

    expect(h.telegram.documents).toHaveLength(1);
    const doc = h.telegram.documents[0]!;
    expect(doc.chatId).toBe(ADMIN_TELEGRAM_ID);
    expect(doc.filename).toMatch(/^gotyoubro-\d{8}T\d{6}Z\.sqlite\.gz$/);
    expect(doc.caption).toMatch(/Services: 1/);
    const sqlite = gunzipSync(doc.content);
    expect(sqlite.subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('runs on schedule only when enabled and due', async () => {
    const admin = createUser(h, ADMIN_TELEGRAM_ID);
    const svc = h.ctx.selfBackup;
    expect(svc.isDue()).toBe(false); // not configured

    await call('PUT', '/self-backup', admin, { enabled: true, intervalHours: 6 });
    expect(svc.isDue()).toBe(true); // never ran → due now
    await svc.run('schedule');
    expect(h.telegram.documents).toHaveLength(1);
    expect(svc.isDue()).toBe(false);

    h.clock.advance(5 * HOUR);
    expect(svc.isDue()).toBe(false);
    h.clock.advance(HOUR);
    expect(svc.isDue()).toBe(true);

    await call('PUT', '/self-backup', admin, { enabled: false, intervalHours: 6 });
    expect(svc.isDue()).toBe(false);
  });

  it('records failures and tells the admin', async () => {
    const admin = createUser(h, ADMIN_TELEGRAM_ID);
    await call('PUT', '/self-backup', admin, { enabled: true, intervalHours: 24 });
    h.telegram.sendDocument = async () => {
      throw new Error('Forbidden: bot was blocked by the user');
    };
    const res = await call('POST', '/self-backup/run', admin);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const status = (await call('GET', '/self-backup', admin)).json().data;
    expect(status).toMatchObject({ lastStatus: 'FAILED', lastError: expect.stringMatching(/blocked/) });
    expect(h.telegram.messages.some((m) => m.chatId === ADMIN_TELEGRAM_ID && /database backup failed/.test(m.text))).toBe(true);
  });
});
