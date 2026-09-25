#!/usr/bin/env node
// GotYouBro heartbeat client for Node.js 18+ (no dependencies).
//
//   GOTYOUBRO_URL=https://gotyoubro.example.com GOTYOUBRO_TOKEN=gyb_... node heartbeat.mjs
//   node heartbeat.mjs --once          # single heartbeat, e.g. at the end of a cron job
//   GOTYOUBRO_MONITOR=worker node heartbeat.mjs   # heartbeat for the service's "worker" monitor
//
// To use it inside your app, copy `sendHeartbeat` and call `startHeartbeat()` once at startup.

import { pathToFileURL } from 'node:url';

const BASE_URL = (process.env.GOTYOUBRO_URL ?? 'http://localhost:6969').replace(/\/+$/, '');
const TOKEN = process.env.GOTYOUBRO_TOKEN;
const INTERVAL_SECONDS = Number(process.env.GOTYOUBRO_INTERVAL ?? 30);
// Optional monitor key (a service can have several monitors: api, worker, nightly-job…).
const MONITOR = process.env.GOTYOUBRO_MONITOR ?? '';

export async function sendHeartbeat() {
  const response = await fetch(`${BASE_URL}/api/v1/health/heartbeat${MONITOR ? `/${encodeURIComponent(MONITOR)}` : ''}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`.trim());
  }
  return body.data; // { serviceId, healthStatus, lastHeartbeatAt, nextHeartbeatDeadline, recovered }
}

/** Send a heartbeat now and then every `intervalSeconds`. Errors are logged, never thrown. */
export function startHeartbeat(intervalSeconds = INTERVAL_SECONDS) {
  const beat = async () => {
    try {
      const data = await sendHeartbeat();
      console.log(`[heartbeat] ${new Date().toISOString()} ${data.healthStatus}${data.recovered ? ' (recovered)' : ''}`);
    } catch (err) {
      // Monitoring must never take your app down.
      console.error(`[heartbeat] failed: ${err.message}`);
    }
  };
  beat();
  const timer = setInterval(beat, intervalSeconds * 1000);
  timer.unref?.(); // don't keep the process alive just for heartbeats
  return () => clearInterval(timer);
}

// Run as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!TOKEN) {
    console.error('Set GOTYOUBRO_TOKEN (and GOTYOUBRO_URL).');
    process.exit(2);
  }
  if (process.argv.includes('--once')) {
    sendHeartbeat()
      .then((data) => console.log(`heartbeat ok: ${data.healthStatus}`))
      .catch((err) => {
        console.error(`heartbeat failed: ${err.message}`);
        process.exit(1);
      });
  } else {
    startHeartbeat();
    setInterval(() => {}, 1 << 30); // keep the standalone script running
  }
}
