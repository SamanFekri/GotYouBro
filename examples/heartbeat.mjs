// Send a heartbeat every 30 seconds. Put this inside your app, or run it next to it.
// Usage: GOTYOUBRO_URL=https://your-domain.com GOTYOUBRO_TOKEN=gyb_... node examples/heartbeat.mjs
const baseUrl = process.env.GOTYOUBRO_URL ?? 'http://localhost:6969';

async function heartbeat() {
  try {
    const response = await fetch(`${baseUrl}/api/v1/health/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GOTYOUBRO_TOKEN}` },
    });
    const body = await response.json();
    console.log(new Date().toISOString(), response.status, body.data?.healthStatus ?? body.error?.code);
  } catch (err) {
    // Never let monitoring crash your app.
    console.error('heartbeat failed:', err.message);
  }
}

await heartbeat();
setInterval(heartbeat, 30_000);
