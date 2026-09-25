# GotYouBro client examples

Ready-to-use clients in **Node.js**, **Python** and **Go**. None of them need extra packages; each uses only its language's standard library.

| | Node.js (20+) | Python (3.8+) | Go (1.21+) |
|---|---|---|---|
| Heartbeat | [`node/heartbeat.mjs`](node/heartbeat.mjs) | [`python/heartbeat.py`](python/heartbeat.py) | [`go/heartbeat`](go/heartbeat/main.go) |
| Backup (dump → gzip → split → upload) | [`node/backup.mjs`](node/backup.mjs) | [`python/backup.py`](python/backup.py) | [`go/backup`](go/backup/main.go) |
| Restore (rejoin parts → verify → gunzip) | [`node/restore.mjs`](node/restore.mjs) | [`python/restore.py`](python/restore.py) | [`go/restore`](go/restore/main.go) |

There's also a minimal cron-friendly shell script: [`shell/backup-sqlite.sh`](shell/backup-sqlite.sh).

Every client reads the same two environment variables:

```bash
export GOTYOUBRO_URL=https://gotyoubro.example.com
export GOTYOUBRO_TOKEN=gyb_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Heartbeats

Send a heartbeat every 30 seconds (change it with `GOTYOUBRO_INTERVAL`). A failed heartbeat is logged but never crashes your app.

```bash
node   node/heartbeat.mjs
python3 python/heartbeat.py
cd go && go run ./heartbeat
```

**Several monitors per service.** A service can have any number of monitors, for example `api`, `worker` and `nightly-job`, each with its own interval, alerts and 7-day history. Create them on the service page in the Web App, then set `GOTYOUBRO_MONITOR=<key>`. The client then posts to `/api/v1/health/heartbeat/<key>`. Without it, the heartbeat goes to the service's `default` monitor (or its only monitor).

Add `--once` (`-once` in Go) to send a single heartbeat and exit. This suits cron jobs: when a job stops running, its heartbeats stop and GotYouBro alerts you.

```cron
0 3 * * *  /usr/local/bin/nightly-job && node /opt/gotyoubro/node/heartbeat.mjs --once
```

To run heartbeats inside your own app, copy the function:

- **Node.js:** `import { startHeartbeat } from './heartbeat.mjs'; startHeartbeat(30);`
- **Python:** `from heartbeat import start_heartbeat; start_heartbeat(30)` (runs in a background thread)
- **Go:** copy `StartHeartbeat` and call `StartHeartbeat(ctx, baseURL, token, 30*time.Second)`

Set the service's heartbeat interval in the Web App a little **longer** than the interval your client sends at, and add a grace period. For example, send every 30s and set interval 60s and grace 30s.

---

## Backups

```text
database ──dump──▶ gzip ──split into parts──▶ upload each part (+ manifest) ──▶ Telegram
```

### Supported sources

| Type | Target | Tool used |
|---|---|---|
| `sqlite` | path to the `.db` file | `sqlite3 .backup` (Python uses its built-in `sqlite3` module), which takes a consistent snapshot while the app is running |
| `mysql` | `mysql://user:pass@host:3306/db`, or just `db` to use `~/.my.cnf` | `mysqldump --single-transaction --routines --triggers --events` |
| `postgres` | `postgres://user:pass@host:5432/db` | `pg_dump --no-owner --no-privileges` (plain SQL) |
| `mongodb` | `mongodb://user:pass@host:27017/db` | `mongodump --archive` |
| `file` | any file, e.g. a `.tar` of uploads | none |

The dump tool must be installed and on your `PATH`. MySQL and Postgres passwords are passed through a private temporary options file or `PGPASSWORD`, so they don't appear in the process list.

### Run

```bash
# Node.js
node node/backup.mjs sqlite   ./data/app.db
node node/backup.mjs postgres postgres://app:secret@localhost:5432/app
node node/backup.mjs mysql    mysql://root:secret@localhost:3306/shop
node node/backup.mjs mongodb  mongodb://localhost:27017/app
node node/backup.mjs file     ./uploads.tar --name uploads

# Python
python3 python/backup.py postgres postgres://app:secret@localhost:5432/app

# Go (flags go before the arguments)
cd go && go run ./backup -name shop mysql mysql://root:secret@localhost:3306/shop
```

| Option | Meaning |
|---|---|
| `--name <prefix>` | File name prefix. Default: the source type. Files are named `<prefix>-<UTC timestamp>.<ext>.gz`. |
| `--part-size-mb <n>` | Size of each part. Default: **95% of the server's limit** for your token, read from `GET /api/v1/service`. |
| `--keep` | Keep the local temporary files and print where they are. |

### How splitting works

- **The part size adapts to your server.** With the official Telegram Bot API the limit is 50 MB, so parts are about 47 MB. With a local Bot API server and a 1.5 GB limit, most backups upload as a single file.
- **Small backups aren't split.** If the compressed dump fits in one part, it's uploaded as a single `name.sql.gz`.
- **Large backups become parts plus a manifest.** Parts are named `name.sql.gz.part001`, `.part002`, and so on, followed by `name.sql.gz.manifest.json`. The manifest lists every part with its size and SHA-256 checksum, plus the checksum of the whole file.
- **Parts upload in order**, so they appear in sequence in the Telegram chat.
- **Retries are safe.** Each part's file name is its `Idempotency-Key`, so a part that was already delivered is never sent twice, and a failed delivery can be retried.
- **Network errors and 5xx responses** are retried with backoff, up to 5 attempts.
- **Rate-limit responses (`429`)** make the client wait for the time given in `Retry-After`, then continue.

The default backup limit is 30 uploads per hour per user. A backup with many parts may pause for the rate limit partway through; it continues on its own. Admins can raise the limit for your user or service.

---

## Restore

1. Download all the parts (and the `.manifest.json`, if there is one) from the Telegram chat into one folder.
2. Rejoin them:

   ```bash
   node node/restore.mjs ~/Downloads/backup            # → postgres-20260924T030000Z.sql.gz
   python3 python/restore.py ~/Downloads/backup --extract   # also gunzips → .sql
   cd go && go run ./restore -extract ~/Downloads/backup
   ```

   With a manifest, every part and the joined file are checked against SHA-256, and a corrupt or missing part is named. Without a manifest, files named `*.partNNN` are joined in number order. Any language's restore works with any language's backup.

3. Load the result into the database:

   | Type | Restore command |
   |---|---|
   | SQLite | `gunzip -c app-….sqlite.gz > app.db` |
   | MySQL | `gunzip -c shop-….sql.gz \| mysql -u root -p` (the dump includes `CREATE DATABASE` and `USE`) |
   | Postgres | `createdb app && gunzip -c app-….sql.gz \| psql postgres://…/app` |
   | MongoDB | `gunzip -c app-….archive.gz \| mongorestore --uri=mongodb://… --archive` |

   You can also rejoin by hand, without any script: `cat name.sql.gz.part* > name.sql.gz`

---

## Scheduling

Run backups from cron, a systemd timer, or your platform's scheduler. For example, every night at 03:00:

```cron
0 3 * * *  GOTYOUBRO_URL=https://gotyoubro.example.com GOTYOUBRO_TOKEN=gyb_… \
           node /opt/gotyoubro/node/backup.mjs postgres postgres://app:secret@localhost:5432/app >> /var/log/gotyoubro.log 2>&1
```

To be alerted when a backup job silently stops running, give the job its own service with health monitoring turned on. Then chain a heartbeat after the backup (`backup … && heartbeat --once`), and set the interval to a little over 24 hours.
