import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TELEGRAM_ID, bearer, createHarness, createService, createUser, sessionHeaders, type TestHarness } from './helpers.js';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const beat = (token: string, key?: string) =>
  h.app.inject({ method: 'POST', url: `/api/v1/health/heartbeat${key ? `/${key}` : ''}`, headers: bearer(token) });
const tick = () => h.ctx.healthMonitor.tick();

/** A service with its "default" monitor (interval 60s, grace 30s). */
function monitored() {
  const user = createUser(h);
  const { service, token } = createService(h, user, { healthEnabled: true, interval: 60, grace: 30 });
  return { user, service, token };
}

function monitorOf(serviceId: string, key = 'default') {
  const monitor = h.ctx.monitors.listForService(serviceId).find((m) => m.key === key);
  if (!monitor) throw new Error(`no monitor ${key}`);
  return monitor;
}

function historyOf(serviceId: string, key = 'default') {
  const monitor = monitorOf(serviceId, key);
  return h.ctx.health.history([monitor]).get(monitor.id)!;
}

const rows = () =>
  h.ctx.db.$client.prepare('SELECT event_type, started_at, ended_at FROM health_events ORDER BY started_at').all() as Array<{
    event_type: string;
    started_at: number;
    ended_at: number | null;
  }>;

describe('health monitoring', () => {
  it('heartbeat marks the monitor healthy', async () => {
    const { service, token } = monitored();
    expect(monitorOf(service.id).status).toBe('UNKNOWN');
    const res = await beat(token);
    expect(res.json().data).toMatchObject({ healthStatus: 'HEALTHY', recovered: false, monitor: { key: 'default' } });
    expect(monitorOf(service.id).lastHeartbeatAt).not.toBeNull();
  });

  it('accepts heartbeats with any (ignored) body', async () => {
    const { token } = monitored();
    for (const [type, payload] of [
      ['application/x-www-form-urlencoded', ''],
      ['application/json', '{"status":"ok"}'],
      ['text/plain', 'ping'],
    ]) {
      const res = await h.app.inject({ method: 'POST', url: '/api/v1/health/heartbeat', headers: { ...bearer(token), 'content-type': type! }, payload });
      expect(res.statusCode, type).toBe(200);
    }
  });

  it('stays healthy while heartbeats arrive within interval + grace', async () => {
    const { service, token } = monitored();
    await beat(token);
    h.clock.advance(89_000);
    expect(tick()).toBe(0);
    expect(monitorOf(service.id).status).toBe('HEALTHY');
  });

  it('missed heartbeat marks the monitor down and alerts once', async () => {
    const { user, service, token } = monitored();
    await beat(token);
    h.clock.advance(91_000);

    expect(tick()).toBe(1);
    const down = monitorOf(service.id);
    expect(down).toMatchObject({ status: 'DOWN', downCount: 1 });
    expect(down.wentDownAt).not.toBeNull();

    // Subsequent checks must not re-alert.
    h.clock.advance(60_000);
    expect(tick()).toBe(0);
    h.clock.advance(600_000);
    expect(tick()).toBe(0);

    const alerts = h.notifier.ofKind('service_down');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.target.telegramId).toBe(user.telegramId);
    expect(alerts[0]!.message).toMatchObject({ serviceName: 'Production API', monitorName: 'Default' });
  });

  it('recovery marks healthy, aggregates downtime and notifies once', async () => {
    const { service, token } = monitored();
    await beat(token);
    h.clock.advance(91_000);
    tick();
    h.clock.advance(120_000);

    const res = await beat(token);
    expect(res.json().data).toMatchObject({ healthStatus: 'HEALTHY', recovered: true });
    const recovered = monitorOf(service.id);
    expect(recovered).toMatchObject({ status: 'HEALTHY', totalDowntimeSeconds: 120, wentDownAt: null });
    expect(recovered.lastRecoveredAt).not.toBeNull();

    await beat(token);
    await beat(token);
    expect(h.notifier.ofKind('service_recovered')).toHaveLength(1);
    expect(h.notifier.ofKind('service_recovered')[0]!.message).toMatchObject({ downtimeSeconds: 120 });

    const outages = h.ctx.health.serviceOutages(service.id);
    expect(outages).toHaveLength(1);
    expect(outages[0]).toMatchObject({ eventType: 'OUTAGE', durationSeconds: 120, monitorKey: 'default' });
  });

  it('handles repeated outages', async () => {
    const { service, token } = monitored();
    for (let i = 0; i < 3; i++) {
      await beat(token);
      h.clock.advance(100_000);
      tick();
    }
    await beat(token);
    expect(monitorOf(service.id).downCount).toBe(3);
    expect(h.notifier.ofKind('service_down')).toHaveLength(3);
    expect(h.notifier.ofKind('service_recovered')).toHaveLength(3);
  });

  it('never stores individual heartbeats', async () => {
    const { token } = monitored();
    const tables = h.ctx.db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.map((t) => (t as { name: string }).name)).not.toContain('health_checks');
    for (let i = 0; i < 50; i++) {
      await beat(token);
      h.clock.advance(1000);
    }
    // Only the initial "no data until the first heartbeat" period exists; heartbeats add nothing.
    expect(rows()).toHaveLength(1);
  });

  it('does not alert for monitors that never received a heartbeat, or when disabled', async () => {
    const { user, service, token } = monitored();
    h.clock.advance(10 * 60_000);
    expect(tick()).toBe(0);

    await beat(token);
    h.ctx.monitors.update(user.id, monitorOf(service.id).id, { enabled: false });
    h.clock.advance(10 * 60_000);
    expect(tick()).toBe(0);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('does not alert while the service is disabled', async () => {
    const { user, service, token } = monitored();
    await beat(token);
    h.ctx.services.update(user, service.id, { status: 'DISABLED' });
    h.clock.advance(10 * 60_000);
    expect(tick()).toBe(0);
    expect(monitorOf(service.id).status).toBe('UNKNOWN');
  });

  it('respects the per-monitor notification toggle', async () => {
    const { user, service, token } = monitored();
    h.ctx.monitors.update(user.id, monitorOf(service.id).id, { notify: false });
    await beat(token);
    h.clock.advance(100_000);
    expect(tick()).toBe(1);
    expect(h.notifier.sent).toHaveLength(0);
  });
});

describe('multiple monitors per service', () => {
  it('tracks each monitor independently by key', async () => {
    const { user, service, token } = monitored();
    const worker = h.ctx.monitors.create(user, service, { name: 'Queue worker', intervalSeconds: 300, graceSeconds: 60 });
    expect(worker.key).toBe('queue-worker');

    await beat(token); // default
    const res = await beat(token, 'queue-worker');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.monitor).toMatchObject({ key: 'queue-worker', name: 'Queue worker' });

    // The default monitor (90s) goes down; the worker (360s) doesn't.
    h.clock.advance(100_000);
    expect(tick()).toBe(1);
    expect(monitorOf(service.id).status).toBe('DOWN');
    expect(monitorOf(service.id, 'queue-worker').status).toBe('HEALTHY');
    expect(h.notifier.ofKind('service_down')[0]!.message).toMatchObject({ monitorName: 'Default' });

    // The service's overall health is the worst of its monitors.
    const view = h.ctx.services.view(h.ctx.services.get(service.id));
    expect(view.healthStatus).toBe('DOWN');
    expect(view.monitors).toHaveLength(2);
  });

  it('rejects unknown monitor keys', async () => {
    const { token } = monitored();
    const res = await beat(token, 'nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MONITOR_NOT_FOUND');
  });

  it('asks for a key when a service has several monitors but no default', async () => {
    const user = createUser(h);
    const { service, token } = createService(h, user);
    h.ctx.monitors.create(user, service, { name: 'API' });
    h.ctx.monitors.create(user, service, { name: 'Worker' });
    const res = await beat(token);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/heartbeat\/<monitor key>/);
  });

  it('uses the only monitor for a keyless heartbeat', async () => {
    const user = createUser(h);
    const { service, token } = createService(h, user);
    h.ctx.monitors.create(user, service, { name: 'API' });
    const res = await beat(token);
    expect(res.json().data.monitor.key).toBe('api');
  });

  it('manages monitors through the Web App API with ownership checks', async () => {
    const { user, service } = monitored();
    const headers = sessionHeaders(h, user);
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/app/services/${service.id}/monitors`,
      headers,
      payload: { name: 'Nightly job', intervalSeconds: 86400, graceSeconds: 3600 },
    });
    expect(created.statusCode).toBe(201);
    const monitor = created.json().data;
    expect(monitor.key).toBe('nightly-job');

    const dup = await h.app.inject({ method: 'POST', url: `/api/v1/app/services/${service.id}/monitors`, headers, payload: { name: 'x', key: 'nightly-job' } });
    expect(dup.statusCode).toBe(409);

    const other = sessionHeaders(h, createUser(h));
    expect((await h.app.inject({ method: 'PATCH', url: `/api/v1/app/monitors/${monitor.id}`, headers: other, payload: { name: 'pwn' } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/app/monitors/${monitor.id}`, headers: other })).statusCode).toBe(404);

    const patched = await h.app.inject({ method: 'PATCH', url: `/api/v1/app/monitors/${monitor.id}`, headers, payload: { name: 'Nightly backup job' } });
    expect(patched.json().data.name).toBe('Nightly backup job');
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/app/monitors/${monitor.id}`, headers })).statusCode).toBe(200);
  });

  it('limits monitors per service for users but not for admins', async () => {
    h.ctx.settings.updateDefaultLimits({ maxMonitorsPerService: 2 });
    const user = createUser(h);
    const { service } = createService(h, user);
    h.ctx.monitors.create(user, service, { name: 'a' });
    h.ctx.monitors.create(user, service, { name: 'b' });
    expect(() => h.ctx.monitors.create(user, service, { name: 'c' })).toThrow(/at most 2/);

    const admin = createUser(h, ADMIN_TELEGRAM_ID);
    const { service: adminService } = createService(h, admin);
    for (const name of ['a', 'b', 'c', 'd']) h.ctx.monitors.create(admin, adminService, { name });
    expect(h.ctx.monitors.listForService(adminService.id)).toHaveLength(4);
  });
});

describe('backward compatibility', () => {
  it('accepts a keyless heartbeat for a service without monitors (no alerts, like before)', async () => {
    const user = createUser(h);
    const { service, token } = createService(h, user); // monitoring never configured
    const res = await beat(token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ healthEnabled: false, serviceId: service.id });
    h.clock.advance(DAY);
    expect(tick()).toBe(0);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('keeps the legacy service-level health fields and settings', async () => {
    const user = createUser(h);
    const { service } = createService(h, user);
    const headers = sessionHeaders(h, user);
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/app/services/${service.id}`,
      headers,
      payload: { healthEnabled: true, healthIntervalSeconds: 120, healthGraceSeconds: 15 },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().data).toMatchObject({ healthEnabled: true, healthStatus: 'UNKNOWN', healthIntervalSeconds: 120, healthGraceSeconds: 15 });
    expect(monitorOf(service.id)).toMatchObject({ key: 'default', intervalSeconds: 120, graceSeconds: 15, enabled: true });

    const off = await h.app.inject({ method: 'PATCH', url: `/api/v1/app/services/${service.id}`, headers, payload: { healthEnabled: false } });
    expect(off.json().data.healthEnabled).toBe(false);
  });

  it('keeps the legacy fields in GET /api/v1/service', async () => {
    const { token } = monitored();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/service', headers: bearer(token) });
    expect(res.json().data).toMatchObject({
      healthEnabled: true,
      healthStatus: 'UNKNOWN',
      healthIntervalSeconds: 60,
      healthGraceSeconds: 30,
      monitors: [{ key: 'default', heartbeatUrl: '/api/v1/health/heartbeat/default' }],
    });
  });
});

describe('7-day health history', () => {
  it('treats time before the first heartbeat as no data, not as healthy', async () => {
    const { service, token } = monitored();
    h.clock.advance(2 * HOUR);
    await beat(token);
    h.clock.advance(2 * HOUR);

    const history = historyOf(service.id);
    expect(history.segments).toHaveLength(1);
    expect(history.segments[0]!.type).toBe('NO_DATA');
    expect(history.uptimePercent).toBe(100);
    expect(history.lastOutage).toBeNull();
  });

  it('reports outages and uptime over the monitored time', async () => {
    const { service, token } = monitored();
    await beat(token);
    h.clock.advance(91_000);
    tick();
    h.clock.advance(HOUR - 91_000);
    await beat(token);
    h.clock.advance(3 * HOUR);

    const history = historyOf(service.id);
    expect(history.outages).toBe(1);
    expect(history.downtimeSeconds).toBeGreaterThan(3000);
    expect(history.uptimePercent).toBeGreaterThan(70);
    expect(history.uptimePercent).toBeLessThan(90);
    expect(history.lastOutage?.durationSeconds).toBeGreaterThan(3000);
  });

  it('marks gaps while monitoring is switched off', async () => {
    const { user, service, token } = monitored();
    h.clock.advance(HOUR);
    await beat(token);
    h.clock.advance(HOUR);
    const id = monitorOf(service.id).id;
    h.ctx.monitors.update(user.id, id, { enabled: false });
    h.clock.advance(5 * HOUR);
    h.ctx.monitors.update(user.id, id, { enabled: true });
    await beat(token);

    const gaps = historyOf(service.id).segments.filter((s) => s.type === 'NO_DATA');
    expect(gaps).toHaveLength(2);
    expect(gaps[1]!.end!.getTime() - gaps[1]!.start.getTime()).toBe(5 * HOUR);
  });

  it('prunes history older than a week but keeps the most recent outage', async () => {
    const { service, token } = monitored();
    await beat(token);
    for (let i = 0; i < 2; i++) {
      h.clock.advance(100_000);
      tick();
      h.clock.advance(HOUR);
      await beat(token);
    }
    h.clock.advance(8 * DAY);
    await beat(token);

    expect(rows().filter((r) => r.event_type === 'OUTAGE')).toHaveLength(2);
    h.ctx.health.prune();
    const left = rows();
    expect(left).toHaveLength(1);
    expect(left[0]!.event_type).toBe('OUTAGE');

    const history = historyOf(service.id);
    expect(history.outages).toBe(0);
    expect(history.lastOutage).not.toBeNull();
  });

  it('keeps open periods when pruning', async () => {
    const { user, service, token } = monitored();
    await beat(token);
    h.ctx.monitors.update(user.id, monitorOf(service.id).id, { enabled: false });
    h.clock.advance(10 * DAY);
    h.ctx.health.prune();
    expect(rows().some((r) => r.event_type === 'NO_DATA' && r.ended_at === null)).toBe(true);
  });

  it('returns per-monitor history through the Web App API', async () => {
    const { user, token } = monitored();
    await beat(token);
    h.clock.advance(HOUR);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/app/health', headers: sessionHeaders(h, user) });
    const body = res.json().data;
    expect(body.historyDays).toBe(7);
    expect(body.services[0].monitors[0].history).toMatchObject({ uptimePercent: 100, outages: 0, segments: expect.any(Array) });
  });
});
