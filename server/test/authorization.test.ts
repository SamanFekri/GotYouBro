import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TELEGRAM_ID, bearer, createHarness, createService, createUser, createVerifiedDestination, multipart, sessionHeaders, type TestHarness } from './helpers.js';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe('user data isolation', () => {
  it("cannot read, modify or delete another user's service", async () => {
    const alice = createUser(h);
    const bob = createUser(h);
    const { service } = createService(h, alice);
    const headers = sessionHeaders(h, bob);

    for (const req of [
      { method: 'GET' as const, url: `/api/v1/app/services/${service.id}` },
      { method: 'PATCH' as const, url: `/api/v1/app/services/${service.id}`, payload: { name: 'pwned' } },
      { method: 'DELETE' as const, url: `/api/v1/app/services/${service.id}` },
      { method: 'POST' as const, url: `/api/v1/app/services/${service.id}/token` },
      { method: 'DELETE' as const, url: `/api/v1/app/services/${service.id}/token` },
    ]) {
      const res = await h.app.inject({ ...req, headers });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(404);
      expect(res.json().error.code).toBe('SERVICE_NOT_FOUND');
    }
    expect(h.ctx.services.get(service.id).name).toBe('Production API');
  });

  it("does not list another user's services", async () => {
    const alice = createUser(h);
    createService(h, alice);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/app/services', headers: sessionHeaders(h, createUser(h)) });
    expect(res.json().data).toEqual([]);
  });

  it("cannot access another user's backup", async () => {
    const alice = createUser(h);
    const { token } = createService(h, alice);
    const form = multipart('a.db', 'data');
    const upload = await h.app.inject({ method: 'POST', url: '/api/v1/backups?wait=true', headers: { ...bearer(token), ...form.headers }, payload: form.payload });
    const backupId = upload.json().data.id;

    const bob = createUser(h);
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/app/backups/${backupId}`, headers: sessionHeaders(h, bob) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BACKUP_NOT_FOUND');

    const list = await h.app.inject({ method: 'GET', url: '/api/v1/app/backups', headers: sessionHeaders(h, bob) });
    expect(list.json().data.items).toEqual([]);

    // Other services' tokens can't read it either.
    const { token: bobToken } = createService(h, bob);
    const viaApi = await h.app.inject({ method: 'GET', url: `/api/v1/backups/${backupId}`, headers: bearer(bobToken) });
    expect(viaApi.statusCode).toBe(404);
  });

  it("cannot attach another user's destination to a service", async () => {
    const alice = createUser(h);
    const bob = createUser(h);
    const { service } = createService(h, bob);
    const aliceDest = createService(h, alice).service.destinationId!;
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/app/services/${service.id}`,
      headers: sessionHeaders(h, bob),
      payload: { destinationId: aliceDest },
    });
    expect(res.statusCode).toBe(404);
  });

  it("cannot add someone else's private chat as a destination", async () => {
    const alice = createUser(h);
    const bob = createUser(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/app/destinations',
      headers: sessionHeaders(h, bob),
      payload: { name: 'x', chatId: alice.telegramId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('cannot add a group the user does not administer', async () => {
    h.telegram.chats.set(-100123, { id: -100123, type: 'supergroup', title: 'Other', isForum: false });
    const bob = createUser(h);
    h.telegram.members.set(`-100123:${bob.telegramId}`, { status: 'member' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/app/destinations',
      headers: sessionHeaders(h, bob),
      payload: { name: 'x', chatId: -100123 },
    });
    expect(res.statusCode).toBe(403);

    h.telegram.members.set(`-100123:${bob.telegramId}`, { status: 'administrator' });
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/app/destinations',
      headers: sessionHeaders(h, bob),
      payload: { name: 'x', chatId: -100123 },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data).toMatchObject({ type: 'GROUP', verified: true });
  });
});

describe('destination chat ids', () => {
  it('follows a group that was upgraded to a supergroup', async () => {
    const user = createUser(h);
    h.telegram.migrated.set(-4340248637, -1002222333444);
    h.telegram.chats.set(-1002222333444, { id: -1002222333444, type: 'supergroup', title: 'Ops', isForum: false });
    h.telegram.members.set(`-1002222333444:${user.telegramId}`, { status: 'creator' });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/app/destinations',
      headers: sessionHeaders(h, user),
      payload: { name: 'Ops', chatId: -4340248637 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ telegramChatId: -1002222333444, verified: true });
  });

  it('updates existing destinations when re-verifying an upgraded group', async () => {
    const user = createUser(h);
    const dest = createVerifiedDestination(h, user, -555);
    h.telegram.migrated.set(-555, -100555);
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/app/destinations/${dest.id}/verify`, headers: sessionHeaders(h, user) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ telegramChatId: -100555, verified: true });
  });

  it('explains "chat not found" and suggests /connect', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/app/destinations',
      headers: sessionHeaders(h, createUser(h)),
      payload: { name: 'x', chatId: -999 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/\/connect/);
  });
});

describe('admin authorization', () => {
  const adminUrls = ['/api/v1/admin/stats', '/api/v1/admin/users', '/api/v1/admin/services', '/api/v1/admin/backups', '/api/v1/admin/settings/limits', '/api/v1/admin/audit-logs'];

  it('rejects non-admin users on every admin endpoint', async () => {
    const headers = sessionHeaders(h, createUser(h));
    for (const url of adminUrls) {
      const res = await h.app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
    const block = await h.app.inject({ method: 'POST', url: `/api/v1/admin/users/${createUser(h).id}/block`, headers, payload: {} });
    expect(block.statusCode).toBe(403);
  });

  it('allows the root admin', async () => {
    const admin = createUser(h, ADMIN_TELEGRAM_ID);
    const headers = sessionHeaders(h, admin);
    for (const url of adminUrls) {
      const res = await h.app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('lets admins block users and records an audit log', async () => {
    const admin = createUser(h, ADMIN_TELEGRAM_ID);
    const target = createUser(h);
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/admin/users/${target.id}/block`, headers: sessionHeaders(h, admin), payload: { reason: 'spam' } });
    expect(res.statusCode).toBe(200);
    expect(h.ctx.users.getById(target.id)!.blocked).toBe(true);
    expect(h.ctx.audit.list(10, 0).items.map((i) => i.action)).toContain('user.block');
  });

  it('prevents blocking the root admin', async () => {
    const root = createUser(h, ADMIN_TELEGRAM_ID);
    const other = createUser(h);
    h.ctx.users.setRole(other, 'ADMIN');
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/admin/users/${root.id}/block`, headers: sessionHeaders(h, h.ctx.users.getById(other.id)!), payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('users cannot lift an admin suspension', async () => {
    const user = createUser(h);
    const { service } = createService(h, user);
    h.ctx.services.adminSetStatus(service.id, 'SUSPENDED');
    const res = await h.app.inject({ method: 'PATCH', url: `/api/v1/app/services/${service.id}`, headers: sessionHeaders(h, user), payload: { status: 'ACTIVE' } });
    expect(res.statusCode).toBe(403);
  });
});
