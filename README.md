<p align="center">
  <img src="docs/logo.png" alt="GotYouBro logo" width="180" />
</p>

<h1 align="center">GotYouBro</h1>

<p align="center"><b>Telegram backup delivery and heartbeat health monitoring for your apps.</b></p>

Your applications send backups and heartbeats to one small HTTP API. GotYouBro delivers each backup file to a Telegram chat, group, forum topic or channel that you choose. If an app stops sending heartbeats, you get one Telegram alert, and another when it comes back.

It runs as a single Node.js process with SQLite. No Redis, no queue broker, no external database.

```text
 your app ──POST /api/v1/backups──────────▶ GotYouBro ──sendDocument──▶ Telegram chat / group / topic / channel
 your app ──POST /api/v1/health/heartbeat─▶ GotYouBro ──🚨 down / ✅ recovered──▶ your private chat
```

---

## Contents

- [Using GotYouBro](#using-gotyoubro)
  - [1. Open the bot](#1-open-the-bot)
  - [2. Add a destination](#2-add-a-destination)
  - [3. Create a service and get its token](#3-create-a-service-and-get-its-token)
  - [4. Send backups](#4-send-backups)
  - [5. Send heartbeats](#5-send-heartbeats)
  - [API reference](#api-reference)
  - [Limits](#limits)
  - [Admin panel](#admin-panel)
- [Installing GotYouBro](#installing-gotyoubro)
  - [1. Create the Telegram bot](#1-create-the-telegram-bot)
  - [2. Run with Docker Compose](#2-run-with-docker-compose)
  - [3. Put it behind HTTPS](#3-put-it-behind-https)
  - [4. Enable backups up to 1.5 GB](#4-enable-backups-up-to-15-gb)
  - [Configuration](#configuration)
  - [Local development](#local-development)
- [Architecture](#architecture)
- [Security](#security)
- [License](#license)

---

# Using GotYouBro

## 1. Open the bot

Send `/start` to your GotYouBro bot on Telegram and tap **Open GotYouBro**. The Web App signs you in with your Telegram account, so you don't need a password.

Your private chat with the bot is added as your first backup destination automatically.

| Bot command  | What it does                                               |
| ------------ | ---------------------------------------------------------- |
| `/start`     | Register and open the Web App                              |
| `/dashboard` | Open the dashboard                                         |
| `/services`  | List your services with health and backup counts           |
| `/status`    | Quick summary: healthy / down services, recent backups     |
| `/connect`   | Run inside a group or forum topic to deliver backups there |
| `/help`      | Help                                                       |

## 2. Add a destination

A destination is where backup files are sent. The bot always sends a test message first, so a destination is only marked **verified** once delivery really works.

| Type             | How to connect it                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| **Private chat** | Automatic on `/start`, or **Destinations → Use my private chat**.                                    |
| **Group**        | Add the bot to the group. A group admin sends `/connect` in the group.                               |
| **Group topic**  | In a forum group, send `/connect` *inside the topic*. Backups land in that topic (`message_thread_id`). |
| **Channel**      | Add the bot as a channel **admin** with *Post messages*. It connects automatically.                  |

You can also add a destination by chat ID in the Web App. You must be an administrator of that chat; this stops anyone from sending files into chats they don't control.

## 3. Create a service and get its token

A **service** is one of your apps, for example "Production API", "Discord Bot" or "Website". Each service has its own:

- **API token** (`gyb_…`), shown **once** when it's generated. It is stored only as a hash. You can **rotate** it (the old token stops working at once) or **revoke** it.
- **Backup destination**
- **Health monitoring** settings: on/off, heartbeat interval, grace period, and Telegram alerts on/off

In the Web App: **Services → + New**. Copy the token from the dialog.

## 4. Send backups

**Multipart upload** (the file is sent as the `file` form field):

```bash
curl -X POST https://your-domain.com/api/v1/backups \
  -H "Authorization: Bearer $GOTYOUBRO_TOKEN" \
  -F "file=@backup.sqlite"
```

**Raw upload** (the file is the request body):

```bash
curl -X POST https://your-domain.com/api/v1/backups/raw \
  -H "Authorization: Bearer $GOTYOUBRO_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  -H "X-Filename: dump.sql.gz" \
  --data-binary @dump.sql.gz
```

**Node.js:**

```javascript
import { openAsBlob } from 'node:fs';

const formData = new FormData();
formData.append('file', await openAsBlob('./backup.sqlite'), 'backup.sqlite');

const response = await fetch('https://your-domain.com/api/v1/backups', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.GOTYOUBRO_TOKEN}`,
  },
  body: formData,
});

console.log(await response.json());
```

The file arrives in Telegram with a caption like this:

```text
📦 Backup

Service: Production API
File: database.sqlite
Size: 12.4 MB
Backup ID: k3j9x2m4q8w1z7p0
Created: 2026-09-23 18:30 UTC
```

### What happens to an upload

```text
Request → Authentication → Rate limit → Validate service & destination → Validate file (streamed, size-checked)
        → Backup record (RECEIVED) → Queue → PROCESSING → Telegram → SUCCESS / FAILED → temp file deleted
```

- By default the API replies **`202 Accepted`** straight away with a backup `id`. Check the result with `GET /api/v1/backups/{id}`.
- Add **`?wait=true`** to wait for delivery. You then get `200` when the file is delivered, or `502 TELEGRAM_DELIVERY_FAILED` if Telegram rejected it.
- Send an **`Idempotency-Key`** header so retries never create duplicates. Repeating a request with the same key (per service) returns the original backup, marked `"idempotent": true`.
- Files are stored only temporarily, on the server's disk, while they are delivered. They are deleted afterwards, whether delivery succeeds or fails.
- If a backup fails, the service owner gets a Telegram message (this can be turned off in **Settings**).

More examples are in [`examples/`](examples/), including a cron-ready [SQLite backup script](examples/backup-sqlite.sh).

## 5. Send heartbeats

Turn on **health monitoring** for the service, then call the heartbeat endpoint from your app on a regular schedule:

```bash
curl -X POST https://your-domain.com/api/v1/health/heartbeat \
  -H "Authorization: Bearer $GOTYOUBRO_TOKEN"
```

```javascript
await fetch('https://your-domain.com/api/v1/health/heartbeat', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.GOTYOUBRO_TOKEN}`,
  },
});
```

How monitoring works:

| State       | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `UNKNOWN`   | Monitoring is on, but no heartbeat has arrived yet (or monitoring was just turned on) |
| `HEALTHY`   | The last heartbeat arrived within *interval + grace*                                |
| `DOWN`      | No heartbeat for longer than *interval + grace*                                    |

- The service is marked **DOWN** once no heartbeat has arrived for *interval + grace* seconds. You get **one** alert, never a repeat every minute:

  ```text
  🚨 Service Down

  Service: Production API

  No heartbeat has been received within
  the configured timeout.

  Last heartbeat:
  18:02 UTC
  ```

- The next heartbeat marks it **HEALTHY** again and sends **one** recovery message, including how long the outage lasted.
- Heartbeats are **not stored**. Each one only updates the current state on the service. The database records one row per outage, so it grows with incidents, not with how often you send heartbeats.
- The Web App shows current state, last heartbeat, total downtime, outage count and outage history.

## API reference

Interactive OpenAPI docs are served at **`/api/docs`**. The raw spec is at `/api/docs/json`.

| Method | Endpoint                   | Purpose                                     |
| ------ | -------------------------- | ------------------------------------------- |
| `POST` | `/api/v1/backups`          | Upload a backup (multipart, field `file`)   |
| `POST` | `/api/v1/backups/raw`      | Upload a backup (raw body)                  |
| `GET`  | `/api/v1/backups/{id}`     | Backup status                               |
| `POST` | `/api/v1/health/heartbeat` | Heartbeat                                   |
| `GET`  | `/api/v1/service`          | Which service this token belongs to, and its limits |
| `GET`  | `/health`                  | Liveness probe                              |
| `GET`  | `/ready`                   | Readiness probe (checks SQLite)             |

All responses use one format:

```json
{ "success": true, "data": { "id": "k3j9x2m4q8w1z7p0", "status": "RECEIVED" } }
```

```json
{ "success": false, "error": { "code": "RATE_LIMITED", "message": "Too many requests" } }
```

| Code                         | HTTP | Meaning                                              |
| ---------------------------- | ---- | ---------------------------------------------------- |
| `UNAUTHORIZED`               | 401  | Missing credentials                                  |
| `INVALID_TOKEN`              | 401  | Unknown token                                        |
| `TOKEN_REVOKED`              | 401  | Token was revoked or rotated                         |
| `FORBIDDEN`                  | 403  | Not allowed                                          |
| `USER_BLOCKED`               | 403  | The owner's account is blocked                       |
| `SERVICE_DISABLED`           | 403  | Service disabled, suspended, or API access off       |
| `LIMIT_EXCEEDED`             | 403  | Maximum number of services reached                   |
| `SERVICE_NOT_FOUND`          | 404  | Unknown service, or one that belongs to another user |
| `INVALID_FILE`               | 400  | Missing or empty file                                |
| `FILE_TOO_LARGE`             | 413  | File is over the size limit                          |
| `DESTINATION_NOT_CONFIGURED` | 422  | The service has no destination                       |
| `DESTINATION_NOT_VERIFIED`   | 422  | The destination hasn't been verified yet             |
| `RATE_LIMITED`               | 429  | Too many requests (see `Retry-After`)                |
| `TELEGRAM_DELIVERY_FAILED`   | 502  | Telegram rejected the upload                         |

## Limits

Defaults (admins can change them at runtime):

| Limit                       | Default        | Scope                              |
| --------------------------- | -------------- | ---------------------------------- |
| API requests                | 60 / minute    | per user, all services combined    |
| Backup uploads              | 30 / hour      | per user, all services combined    |
| Heartbeats                  | 10 / minute    | per service                        |
| Service creation            | 10 / hour      | per user                           |
| Any `/api` request          | 300 / minute   | per IP                             |
| Max backup size             | 1.5 GB         | per user, overridable per service  |
| Max services                | 10             | per user                           |

API and backup limits are counted **per user** across all of that user's services, so creating more services doesn't give more quota. Admins can set overrides for a single user or a single service. Responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`, and a `429` response also includes `Retry-After`.

> The official Telegram Bot API only accepts uploads of up to **50 MB**, so the effective limit is 50 MB until you enable the [local Bot API server](#4-enable-backups-up-to-15-gb) (up to 2000 MB). GotYouBro always applies the smaller of the two limits, and rejects oversized files with `413 FILE_TOO_LARGE` before anything is sent to Telegram.

## Admin panel

The user whose Telegram ID matches `ADMIN_TELEGRAM_ID` is the **root admin**. The server decides who is an admin; the Web App can't claim it. The **More → Admin panel** section is visible only to admins. It offers:

- System statistics: users, services, health, backups, queue, uptime
- A user list with search; per-user details: services, destinations, recent backups
- Block and unblock users. A blocked user's tokens stop working immediately.
- Suspend and re-enable services. Only an admin can lift a suspension.
- Change default rate limits and sizes, and set per-user and per-service overrides
- Backup activity across all users
- An audit log of admin and security actions: blocks, limit changes, token create/rotate/revoke, service deletion
- The root admin can promote other users to admin

---

# Installing GotYouBro

## 1. Create the Telegram bot

1. Message [@BotFather](https://t.me/BotFather), run `/newbot` and copy the **bot token**.
2. Find your numeric Telegram ID (e.g. via [@userinfobot](https://t.me/userinfobot)). This becomes the root admin.
3. *(For groups)* In BotFather → **Bot Settings → Group Privacy**, you can leave privacy **on**. `/connect` still reaches the bot because it's a command.

GotYouBro sets the bot's command list and the **Open** menu button automatically on startup.

## 2. Run with Docker Compose

```bash
git clone https://github.com/<you>/GotYouBro.git
cd GotYouBro
cp .env.example .env
```

Edit `.env` and set at least:

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
ADMIN_TELEGRAM_ID=123456789
WEBAPP_URL=https://gotyoubro.example.com
JWT_SECRET=<output of: openssl rand -hex 32>
TRUST_PROXY=true   # when behind a reverse proxy
```

Start it:

```bash
docker compose up -d --build
docker compose logs -f
```

The SQLite database is saved in `./data` (mounted at `/app/data`). The app runs as the non-root `node` user (uid 1000). On start, the container makes `./data` writable for that user, so a root-owned folder is fine.

The container includes a health check on `/ready`. To upgrade: `git pull && docker compose up -d --build`. Database migrations run automatically on startup.

## 3. Put it behind HTTPS

Telegram only opens Web Apps over **HTTPS**, so put GotYouBro behind a reverse proxy with TLS and set `WEBAPP_URL` to that public URL. For example, with [Caddy](https://caddyserver.com/):

```caddy
gotyoubro.example.com {
    request_body {
        max_size 1600MB
    }
    reverse_proxy localhost:6969
}
```

With **nginx**:

```nginx
server {
    listen 80;
    server_name gotyoubro.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name gotyoubro.example.com;

    ssl_certificate     /etc/ssl/gotyoubro/fullchain.pem;
    ssl_certificate_key /etc/ssl/gotyoubro/privkey.pem;

    # Max backup size (1.5 GB) plus multipart overhead.
    client_max_body_size 1600M;

    location / {
        proxy_pass http://127.0.0.1:6969;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Stream uploads straight to GotYouBro instead of spooling them to nginx's disk first.
        proxy_request_buffering off;
        proxy_http_version 1.1;

        # Large uploads and ?wait=true can take several minutes.
        client_body_timeout 300s;
        proxy_send_timeout  900s;
        proxy_read_timeout  900s;
    }
}
```

One `location /` serves both the Web App and the API, because they share one origin. The bot uses long polling, so you don't need to expose a webhook.

## 4. Enable backups up to 1.5 GB

The default max backup size is **1.5 GB**, but the official Bot API rejects files over 50 MB. Larger uploads need Telegram's [local Bot API server](https://github.com/tdlib/telegram-bot-api), which accepts files up to 2000 MB. It's included in `docker-compose.yml` as an optional profile.

1. Get an `api_id` and `api_hash` at [my.telegram.org](https://my.telegram.org) → *API development tools*.
2. Log the bot out of the official API once. This is required before a bot can move to a local server:

   ```bash
   curl https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/logOut
   ```

3. Add to `.env`:

   ```env
   TELEGRAM_API_ID=12345678
   TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
   TELEGRAM_API_ROOT=http://telegram-bot-api:8081
   ```

4. Start both containers:

   ```bash
   docker compose --profile local-bot-api up -d --build
   ```

When `TELEGRAM_API_ROOT` is set, the Telegram cap rises to 2000 MB automatically, so the 1.5 GB default applies. Temporary uploads are stored in `./data/tmp` while they're delivered, so leave enough free disk for `BACKUP_CONCURRENCY` × max backup size. A 1.5 GB upload can take a few minutes to reach Telegram, and `?wait=true` waits up to `BACKUP_WAIT_TIMEOUT_SECONDS` (default 600).

## Configuration

Every option is documented in [`.env.example`](.env.example). The main ones:

| Variable                        | Default                     | Description                                           |
| ------------------------------- | --------------------------- | ----------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`            | —                           | Bot token from BotFather (**required** in production)  |
| `ADMIN_TELEGRAM_ID`             | —                           | Root admin's Telegram user ID                          |
| `WEBAPP_URL`                    | —                           | Public HTTPS URL (**required** in production)          |
| `JWT_SECRET`                    | random per start            | Session signing key, ≥ 32 chars (**required** in production) |
| `DATABASE_URL`                  | `file:./data/gotyoubro.db`  | SQLite file                                            |
| `PORT`                          | `6969`                      | HTTP port                                              |
| `TRUST_PROXY`                   | `false`                     | Trust `X-Forwarded-*` (needed for per-IP limits behind a proxy) |
| `MAX_BACKUP_SIZE_MB`            | `1536`                      | Default max backup size (capped by `TELEGRAM_MAX_FILE_MB`) |
| `MAX_SERVICES_PER_USER`         | `10`                        | Default max services per user                          |
| `DEFAULT_API_RATE_LIMIT`        | `60/minute`                 | Per-user API limit                                     |
| `DEFAULT_BACKUP_RATE_LIMIT`     | `30/hour`                   | Per-user backup limit                                  |
| `DEFAULT_HEARTBEAT_RATE_LIMIT`  | `10/minute`                 | Per-service heartbeat limit                            |
| `HEALTH_CHECK_INTERVAL_SECONDS` | `30`                        | How often the monitor looks for overdue services       |
| `TELEGRAM_API_ROOT`             | —                           | Local Bot API server URL (for files larger than 50 MB) |
| `TELEGRAM_MAX_FILE_MB`          | `50`, or `2000` with `TELEGRAM_API_ROOT` | Hard cap on what's sent to Telegram       |
| `LOG_LEVEL`                     | `info`                      | `debug`, `info`, `warn`, `error`                       |

Rate limits accept `60/minute`, `30/hour`, `100/15m`, `unlimited`, or a bare number.

## Local development

Requirements: **Node.js 22+**.

```bash
npm install
cp .env.example .env          # set TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_ID, JWT_SECRET

npm run dev                   # API + bot on http://localhost:6969 (auto-reload)
npm run dev:webapp            # Web App on http://localhost:3001 (proxies /api to :6969)
```

To test the Web App inside Telegram, expose port 3001 (or 6969 after `npm run build`) through an HTTPS tunnel, for example `cloudflared tunnel --url http://localhost:3001`, and set `WEBAPP_URL` to the tunnel URL. In a normal browser the app shows an "Open from Telegram" screen, because sign-in needs Telegram's signed `initData`.

| Command               | What it does                                                  |
| --------------------- | ------------------------------------------------------------- |
| `npm test`            | Run the server test suite (Vitest)                            |
| `npm run build`       | Build the Web App (static) and the server (TypeScript)         |
| `npm start`           | Run the built server. It also serves the built Web App.        |
| `npm run typecheck`   | Type-check server and Web App                                 |
| `npm run db:generate` | Generate a new migration after changing `server/src/database/schema.ts` |

The tests cover token authentication (valid, invalid, revoked, rotated, blocked user), Web App `initData` validation, user isolation and admin authorization, backups (success, raw, invalid file, too large, Telegram failure, idempotency), health (healthy, down, recovery, one alert per outage, no heartbeat rows) and rate limits (API, backup, per-user aggregation, per-service and per-user overrides).

---

# Architecture

```text
server/src/
  api/v1/
    backups/     multipart + raw upload, status          (service token)
    health/      heartbeat                               (service token)
    service/     token introspection                     (service token)
    app/         Web App API                             (Telegram session)
    admin/       admin API                               (admin session)
  auth/          initData validation, session guard, service-token guard
  bot/           Telegraf bot: /start, /connect, channel auto-connect, status
  services/      business logic: services, credentials, destinations, backups, health, users, settings, audit
  telegram/      Telegram gateway + TelegramBackupDestination / TelegramNotificationProvider
  workers/       in-process backup queue, health monitor timer
  rate-limit/    in-memory limiter + limit resolution (service → user → admin default → env)
  database/      Drizzle schema, SQLite client, migrations (server/drizzle/)
  config/        validated environment configuration
webapp/app/      Nuxt 4 SPA (Vue 3 + Pinia) served by the API server
```

- **One process, one container.** Fastify serves the API, the OpenAPI docs and the built Web App. The Telegram bot, the backup queue and the health monitor run in the same process.
- **SQLite** via Drizzle ORM and better-sqlite3 (WAL mode). Tables: `users`, `services`, `api_credentials`, `destinations`, `backups`, `health_events`, `audit_logs`, `settings`. There is **no heartbeat table**.
- **Providers.** Backup delivery and notifications go through `BackupDestinationProvider` and `NotificationProvider` interfaces. Only Telegram is implemented today; another target such as S3 can be added without touching the core backup flow.
- **Restarts.** Backups still in flight when the process stops are marked `FAILED` (`INTERRUPTED`) on the next start, and leftover temp files are cleaned up.

# Security

- Telegram Web App `initData` is verified with HMAC-SHA256 using the bot token, and its age is checked. The user's identity comes only from that signed data.
- Sessions are short-lived HS256 JWTs. The user is re-loaded on every request, so blocks and role changes apply immediately.
- API tokens have 256 bits of randomness. Only their SHA-256 hash and a short display prefix are stored, and full tokens are never logged.
- Every query is scoped to the owner. Another user's resources return `404`, so their existence isn't revealed.
- Admin rights are decided server-side (`ADMIN_TELEGRAM_ID` plus roles granted by the root admin).
- Input is validated with Zod. Uploads are streamed with hard size limits, filenames are sanitized, and temp files use server-generated names inside a fixed directory.
- Helmet sets security headers, with a CSP that allows only Telegram to frame the app. CORS is limited to the Web App origin.
- Logs redact authorization headers, tokens and `initData`.
- Admin and security actions are written to the audit log.

# License

[MIT](LICENSE)
