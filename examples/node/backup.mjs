#!/usr/bin/env node
// GotYouBro backup client for Node.js 20+ (no npm dependencies).
//
// Dumps a database, gzips it, splits it into parts that fit the server's upload limit and
// uploads every part. Split backups also get a small manifest (<name>.manifest.json) so
// restore.mjs can verify and rejoin the parts.
//
//   node backup.mjs sqlite   ./data/app.db
//   node backup.mjs postgres postgres://user:pass@localhost:5432/app
//   node backup.mjs mysql    mysql://user:pass@localhost:3306/app
//   node backup.mjs mongodb  mongodb://localhost:27017/app
//   node backup.mjs file     ./uploads.tar
//
// Options: --name <prefix>  --part-size-mb <n>  --keep (keep the local parts)
// Env:     GOTYOUBRO_URL, GOTYOUBRO_TOKEN
// Requires the matching CLI tool: sqlite3, mysqldump, pg_dump or mongodump.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';

const BASE_URL = (process.env.GOTYOUBRO_URL ?? 'http://localhost:6969').replace(/\/+$/, '');
const TOKEN = process.env.GOTYOUBRO_TOKEN;
const MB = 1024 * 1024;
const MAX_ATTEMPTS = 5;

const RESTORE_HINTS = {
  sqlite: 'gunzip -c {file} > app.db',
  mysql: 'gunzip -c {file} | mysql -u root -p',
  postgres: 'gunzip -c {file} | psql postgres://user:pass@host:5432/app',
  mongodb: 'gunzip -c {file} | mongorestore --uri=mongodb://host:27017 --archive',
  file: 'gunzip -c {file} > restored-file',
};

// ---------------------------------------------------------------- dump sources

/** Returns a readable stream with the raw dump plus a promise that rejects if the dump tool fails. */
function openSource(type, target, workDir) {
  switch (type) {
    case 'sqlite': {
      if (!fs.existsSync(target)) throw new Error(`SQLite database not found: ${target}`);
      // `.backup` takes a consistent snapshot even while the app is writing.
      const snapshot = path.join(workDir, 'snapshot.sqlite');
      const done = run('sqlite3', [target, `.backup '${snapshot.replace(/'/g, "''")}'`]);
      return { ext: 'sqlite', stream: done.then(() => fs.createReadStream(snapshot)) };
    }
    case 'mysql':
      return { ext: 'sql', ...spawnDump('mysqldump', mysqlArgs(target, workDir)) };
    case 'postgres': {
      // Move the password into PGPASSWORD so it doesn't show up in `ps`.
      const env = { ...process.env };
      let dbname = target;
      if (/^postgres(ql)?:\/\//.test(target)) {
        const url = new URL(target);
        if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
        url.password = '';
        dbname = url.toString();
      }
      return { ext: 'sql', ...spawnDump('pg_dump', ['--no-owner', '--no-privileges', `--dbname=${dbname}`], env) };
    }
    case 'mongodb':
      return { ext: 'archive', ...spawnDump('mongodump', [`--uri=${target}`, '--archive']) };
    case 'file':
      return { ext: path.basename(target), stream: Promise.resolve(fs.createReadStream(target)) };
    default:
      throw new Error(`Unknown source type "${type}" (sqlite, mysql, postgres, mongodb, file)`);
  }
}

/**
 * `mysql://user:pass@host:3306/db` or just `db` (then ~/.my.cnf / defaults are used).
 * The password goes into a private options file instead of the command line.
 */
function mysqlArgs(target, workDir) {
  const args = ['--single-transaction', '--routines', '--triggers', '--events'];
  let database = target;
  if (target.startsWith('mysql://')) {
    const url = new URL(target);
    database = decodeURIComponent(url.pathname.slice(1));
    if (url.hostname) args.push(`--host=${url.hostname}`);
    if (url.port) args.push(`--port=${url.port}`);
    if (url.username) args.push(`--user=${decodeURIComponent(url.username)}`);
    if (url.password) {
      const cnf = path.join(workDir, 'client.cnf');
      const password = decodeURIComponent(url.password).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      fs.writeFileSync(cnf, `[client]\npassword="${password}"\n`, { mode: 0o600 });
      args.unshift(`--defaults-extra-file=${cnf}`); // must be the first option
    }
  }
  if (!database) throw new Error('MySQL: no database name in the target');
  return [...args, '--databases', database];
}

function spawnDump(command, args, env = process.env) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], env });
  const exited = new Promise((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`Cannot run ${command}: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });
  return { stream: Promise.resolve(child.stdout), exited };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', (err) => reject(new Error(`Cannot run ${command}: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });
}

// ---------------------------------------------------------------- splitting

/** Writable that cuts the incoming bytes into fixed-size part files and hashes everything. */
class PartWriter extends Writable {
  constructor(dir, baseName, partSize) {
    super();
    Object.assign(this, { dir, baseName, partSize, parts: [], total: 0, fd: null });
    this.hash = createHash('sha256');
  }

  _openPart() {
    const file = path.join(this.dir, `${this.baseName}.part${String(this.parts.length + 1).padStart(3, '0')}`);
    this.fd = fs.openSync(file, 'w');
    this.parts.push({ path: file, size: 0, hash: createHash('sha256') });
  }

  _write(chunk, _encoding, callback) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        let part = this.parts.at(-1);
        if (!part || part.size >= this.partSize) {
          if (this.fd !== null) fs.closeSync(this.fd);
          this._openPart();
          part = this.parts.at(-1);
        }
        const slice = chunk.subarray(offset, offset + (this.partSize - part.size));
        fs.writeSync(this.fd, slice);
        part.size += slice.length;
        part.hash.update(slice);
        offset += slice.length;
      }
      this.hash.update(chunk);
      this.total += chunk.length;
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _final(callback) {
    if (this.fd !== null) fs.closeSync(this.fd);
    callback();
  }
}

// ---------------------------------------------------------------- upload

async function api(pathname, init = {}) {
  return fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
}

/** The server tells us the largest file it accepts for this token (min of admin limit and Telegram). */
async function serverMaxBytes() {
  try {
    const res = await api('/api/v1/service');
    const body = await res.json();
    return body.data?.limits?.maxBackupBytes;
  } catch {
    return undefined;
  }
}

async function uploadFile(filePath, fileName) {
  for (let attempt = 1; ; attempt++) {
    let res;
    let body = {};
    try {
      res = await api('/api/v1/backups/raw?wait=true', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(fileName),
          // Same key on retry: a delivered part is never sent twice, a failed one is retried.
          'Idempotency-Key': fileName.slice(-128),
        },
        body: await fs.openAsBlob(filePath),
      });
      body = await res.json().catch(() => ({}));
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await retryWait(attempt, `network error: ${err.message}`);
      continue;
    }

    if (res.ok) return body.data; // 200 delivered, 202 still being delivered
    const reason = `${res.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`.trim();
    if (res.status === 429) {
      const seconds = Number(res.headers.get('retry-after') ?? 60);
      console.log(`  rate limited, waiting ${seconds}s…`);
      await sleep(seconds * 1000);
      attempt--; // rate limiting isn't a failure
      continue;
    }
    if ((res.status >= 500 || res.status === 408) && attempt < MAX_ATTEMPTS) {
      await retryWait(attempt, reason);
      continue;
    }
    throw new Error(`Upload of ${fileName} failed: ${reason}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retryWait(attempt, reason) {
  const seconds = Math.min(60, 2 ** attempt * 2);
  console.log(`  ${reason} — retrying in ${seconds}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
  await sleep(seconds * 1000);
}

// ---------------------------------------------------------------- main

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      'part-size-mb': { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  const [type, target] = positionals;
  if (!type || !target) {
    console.error('Usage: node backup.mjs <sqlite|mysql|postgres|mongodb|file> <target> [--name x] [--part-size-mb n] [--keep]');
    process.exit(2);
  }
  if (!TOKEN) throw new Error('Set GOTYOUBRO_TOKEN');

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const prefix = values.name ?? (type === 'file' ? 'file' : type);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gotyoubro-'));

  try {
    // 1. Dump → gzip → parts
    const source = openSource(type, target, workDir);
    const baseName = `${prefix}-${stamp}.${source.ext}.gz`.replace(/[^\w.-]+/g, '_');

    const serverMax = await serverMaxBytes();
    const partSize = values['part-size-mb']
      ? Number(values['part-size-mb']) * MB
      : Math.floor((serverMax ?? 50 * MB) * 0.95); // leave headroom below the limit

    console.log(`Dumping ${type} → ${baseName} (parts of ${(partSize / MB).toFixed(1)} MB)`);
    const writer = new PartWriter(workDir, baseName, partSize);
    await Promise.all([pipeline(await source.stream, createGzip({ level: 9 }), writer), source.exited]);
    if (writer.total === 0) throw new Error('The dump is empty');

    // 2. One part → upload as a plain .gz file. Several parts → parts + manifest.
    const uploads = [];
    if (writer.parts.length === 1) {
      const single = path.join(workDir, baseName);
      fs.renameSync(writer.parts[0].path, single);
      uploads.push({ path: single, name: baseName });
    } else {
      const manifest = {
        format: 'gotyoubro-split-v1',
        file: baseName,
        source: type,
        createdAt: new Date().toISOString(),
        size: writer.total,
        sha256: writer.hash.digest('hex'),
        parts: writer.parts.map((p) => ({ file: path.basename(p.path), size: p.size, sha256: p.hash.digest('hex') })),
        restore: `node restore.mjs <folder with the parts> && ${RESTORE_HINTS[type].replace('{file}', baseName)}`,
      };
      const manifestPath = path.join(workDir, `${baseName}.manifest.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      for (const p of writer.parts) uploads.push({ path: p.path, name: path.basename(p.path) });
      uploads.push({ path: manifestPath, name: path.basename(manifestPath) });
    }

    // 3. Upload sequentially (keeps parts in order in the Telegram chat).
    for (const [i, file] of uploads.entries()) {
      const size = fs.statSync(file.path).size;
      console.log(`[${i + 1}/${uploads.length}] uploading ${file.name} (${(size / MB).toFixed(1)} MB)`);
      const result = await uploadFile(file.path, file.name);
      console.log(`  ✓ ${result.status}${result.idempotent ? ' (already uploaded)' : ''} — backup ${result.id}`);
    }
    console.log(`Done: ${(writer.total / MB).toFixed(1)} MB in ${uploads.length} file(s).`);
    if (values.keep) console.log(`Local copy kept in ${workDir}`);
  } finally {
    if (!values.keep) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
});
