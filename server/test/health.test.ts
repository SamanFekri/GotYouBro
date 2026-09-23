import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createHarness, createService, createUser, sessionHeaders, type TestHarness } from './helpers.js';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const beat = (token: string) => h.app.inject({ method: 'POST', url: '/api/v1/health/heartbeat', headers: bearer(token) });
const tick = () => h.ctx.healthMonitor.tick();

function monitored() {
  const user = createUser(h);
  const { service, token } = createService(h, user, { healthEnabled: true, interval: 60, grace: 30 });
  return { user, service, token };
}

describe('health monitoring', () => {
  it('heartbeat marks a service healthy', async () => {
    const { service, token } = monitored();
    expect(h.ctx.services.get(service.id).healthStatus).toBe('UNKNOWN');
    const res = await beat(token);
    expect(res.json().data).toMatchObject({ healthStatus: 'HEALTHY', recovered: false });
    expect(h.ctx.services.get(service.id).lastHeartbeatAt).not.toBeNull();
  });

  it('stays healthy while heartbeats arrive within interval + grace', async () => {
    const { service, token } = monitored();
    await beat(token);
    h.clock.advance(89_000);
    expect(tick()).toBe(0);
    expect(h.ctx.services.get(service.id).healthStatus).toBe('HEALTHY');
  });

  it('missed heartbeat marks the service down and alerts once', async () => {
    const { user, service, token } = monitored();
    await beat(token);
    h.clock.advance(91_000);

    expect(tick()).toBe(1);
    const down = h.ctx.services.get(service.id);
    expect(down).toMatchObject({ healthStatus: 'DOWN', downCount: 1 });
    expect(down.wentDownAt).not.toBeNull();

    // Subsequent checks must not re-alert.
    h.clock.advance(60_000);
    expect(tick()).toBe(0);
    h.clock.advance(600_000);
    expect(tick()).toBe(0);

    const alerts = h.notifier.ofKind('service_down');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.target.telegramId).toBe(user.telegramId);
    expect(alerts[0]!.message).toMatchObject({ serviceName: 'Production API' });
  });

  it('recovery marks healthy, aggregates downtime and notifies once', async () => {
    const { service, token } = monitored();
    await beat(token);
    h.clock.advance(91_000);
    tick();
    h.clock.advance(120_000);

    const res = await beat(token);
    expect(res.json().data).toMatchObject({ healthStatus: 'HEALTHY', recovered: true });
    const recovered = h.ctx.services.get(service.id);
    expect(recovered).toMatchObject({ healthStatus: 'HEALTHY', totalDowntimeSeconds: 120, wentDownAt: null });
    expect(recovered.lastRecoveredAt).not.toBeNull();

    await beat(token);
    await beat(token);
    expect(h.notifier.ofKind('service_recovered')).toHaveLength(1);
    expect(h.notifier.ofKind('service_recovered')[0]!.message).toMatchObject({ downtimeSeconds: 120 });

    const events = h.ctx.health.events(service.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'OUTAGE', durationSeconds: 120 });
  });

  it('handles repeated outages', async () => {
    const { service, token } = monitored();
    for (let i = 0; i < 3; i++) {
      await beat(token);
      h.clock.advance(100_000);
      tick();
    }
    await beat(token);
    expect(h.ctx.services.get(service.id).downCount).toBe(3);
    expect(h.notifier.ofKind('service_down')).toHaveLength(3);
    expect(h.notifier.ofKind('service_recovered')).toHaveLength(3);
  });

  it('never stores individual heartbeats', async () => {
    const { token } = monitored();
    const tablesBefore = h.ctx.db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tablesBefore.map((t) => (t as { name: string }).name)).not.toContain('health_checks');
    for (let i = 0; i < 50; i++) {
      await beat(token);
      h.clock.advance(1000);
    }
    const counts = h.ctx.db.$client.prepare('SELECT (SELECT count(*) FROM health_events) e, (SELECT count(*) FROM audit_logs) a').get() as { e: number; a: number };
    expect(counts.e).toBe(0);
  });

  it('does not alert for services that never sent a heartbeat, or when disabled', async () => {
    const { user, service, token } = monitored();
    h.clock.advance(10 * 60_000);
    expect(tick()).toBe(0);

    await beat(token);
    h.ctx.services.update(user, service.id, { healthEnabled: false });
    h.clock.advance(10 * 60_000);
    expect(tick()).toBe(0);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('respects the per-service notification toggle', async () => {
    const { user, service, token } = monitored();
    h.ctx.services.update(user, service.id, { healthNotify: false });
    await beat(token);
    h.clock.advance(100_000);
    expect(tick()).toBe(1);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('exposes health state in the Web App API', async () => {
    const { user, token } = monitored();
    await beat(token);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/app/health', headers: sessionHeaders(h, user) });
    expect(res.json().data.services[0]).toMatchObject({ healthStatus: 'HEALTHY', downCount: 0 });
  });
});
