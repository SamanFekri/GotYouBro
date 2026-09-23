import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramApiError } from '../src/telegram/gateway.js';
import { bearer, createHarness, createService, createUser, multipart, type TestHarness } from './helpers.js';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness({ MAX_BACKUP_SIZE_MB: '1' });
});
afterEach(async () => {
  await h.close();
});

function upload(token: string, filename: string, content: Buffer | string, query = '?wait=true', extraHeaders: Record<string, string> = {}) {
  const form = multipart(filename, content);
  return h.app.inject({ method: 'POST', url: `/api/v1/backups${query}`, headers: { ...bearer(token), ...form.headers, ...extraHeaders }, payload: form.payload });
}

const tmpFiles = () => (fs.existsSync(h.ctx.config.tmpDir) ? fs.readdirSync(h.ctx.config.tmpDir) : []);

describe('backup upload', () => {
  it('delivers a multipart backup to Telegram with metadata', async () => {
    const user = createUser(h);
    const { service, token } = createService(h, user);
    const res = await upload(token, 'database.sqlite', 'SQLite format 3\0...');

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ status: 'SUCCESS', filename: 'database.sqlite', sizeBytes: 19, serviceId: service.id });

    expect(h.telegram.documents).toHaveLength(1);
    const doc = h.telegram.documents[0]!;
    expect(doc.chatId).toBe(user.telegramId);
    expect(doc.content.toString()).toBe('SQLite format 3\0...');
    expect(doc.caption).toContain('Service: Production API');
    expect(doc.caption).toContain(`Backup ID: <code>${data.id}</code>`);
    expect(doc.caption).toContain('Size: 19 B');

    expect(h.ctx.services.get(service.id).backupCount).toBe(1);
    expect(tmpFiles()).toEqual([]);
  });

  it('accepts asynchronously and exposes status by id', async () => {
    const { token } = createService(h, createUser(h));
    const res = await upload(token, 'a.tar.gz', 'abc', '');
    expect(res.statusCode).toBe(202);
    expect(res.json().data.status).toBe('RECEIVED');

    await h.ctx.backupQueue.onIdle();
    const status = await h.app.inject({ method: 'GET', url: `/api/v1/backups/${res.json().data.id}`, headers: bearer(token) });
    expect(status.json().data.status).toBe('SUCCESS');
  });

  it('supports raw uploads with X-Filename', async () => {
    const { token } = createService(h, createUser(h));
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/backups/raw?wait=true',
      headers: { ...bearer(token), 'content-type': 'application/octet-stream', 'x-filename': 'dump%20file.sql.gz' },
      payload: Buffer.from([1, 2, 3, 4]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ filename: 'dump file.sql.gz', sizeBytes: 4, status: 'SUCCESS' });
  });

  it('sanitizes filenames (no path traversal)', async () => {
    const { token } = createService(h, createUser(h));
    const res = await upload(token, '../../etc/passwd', 'x');
    expect(res.json().data.filename).toBe('passwd');
  });

  it('rejects empty files', async () => {
    const { token } = createService(h, createUser(h));
    const res = await upload(token, 'empty.db', '');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FILE');
    expect(tmpFiles()).toEqual([]);
  });

  it('rejects a request without a file part', async () => {
    const { token } = createService(h, createUser(h));
    const boundary = 'xyz';
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { ...bearer(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${boundary}--\r\n`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FILE');
  });

  it('rejects files that are too large (multipart and raw)', async () => {
    const { token } = createService(h, createUser(h));
    const big = Buffer.alloc(1024 * 1024 + 10, 1);
    const res = await upload(token, 'big.bin', big);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');

    const raw = await h.app.inject({
      method: 'POST',
      url: '/api/v1/backups/raw',
      headers: { ...bearer(token), 'content-type': 'application/octet-stream' },
      payload: big,
    });
    expect(raw.statusCode).toBe(413);
    expect(h.telegram.documents).toHaveLength(0);
    expect(tmpFiles()).toEqual([]);
  });

  it('respects a per-service max size override', async () => {
    const { service, token } = createService(h, createUser(h));
    h.ctx.services.adminSetLimits(service.id, { maxBackupSizeMb: 2 });
    const res = await upload(token, 'big.bin', Buffer.alloc(1024 * 1024 + 10, 1));
    expect(res.statusCode).toBe(200);
  });

  it('reports Telegram delivery failures', async () => {
    const user = createUser(h);
    const { token } = createService(h, user);
    h.telegram.failDocumentsWith = new TelegramApiError('Bad Request: chat not found', 400);

    const res = await upload(token, 'db.sqlite', 'data');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('TELEGRAM_DELIVERY_FAILED');
    expect(res.json().error.details.backup.status).toBe('FAILED');

    const failed = h.notifier.ofKind('backup_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.target.telegramId).toBe(user.telegramId);
    expect(tmpFiles()).toEqual([]);
  });

  it('requires a configured, verified destination', async () => {
    const { token } = createService(h, createUser(h), { destination: null });
    const res = await upload(token, 'db.sqlite', 'data');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('DESTINATION_NOT_CONFIGURED');
  });

  it('is idempotent with Idempotency-Key', async () => {
    const { token } = createService(h, createUser(h));
    const first = await upload(token, 'db.sqlite', 'v1', '?wait=true', { 'idempotency-key': 'nightly-2026-09-23' });
    const second = await upload(token, 'db.sqlite', 'v1', '?wait=true', { 'idempotency-key': 'nightly-2026-09-23' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().data).toMatchObject({ id: first.json().data.id, idempotent: true });
    expect(h.telegram.documents).toHaveLength(1);

    const other = await upload(token, 'db.sqlite', 'v2', '?wait=true', { 'idempotency-key': 'nightly-2026-09-24' });
    expect(other.json().data.id).not.toBe(first.json().data.id);
    expect(h.telegram.documents).toHaveLength(2);
  });

  it('scopes idempotency keys per service', async () => {
    const user = createUser(h);
    const a = createService(h, user, { name: 'A' });
    const b = createService(h, user, { name: 'B' });
    const r1 = await upload(a.token, 'x', '1', '?wait=true', { 'idempotency-key': 'same' });
    const r2 = await upload(b.token, 'x', '1', '?wait=true', { 'idempotency-key': 'same' });
    expect(r1.json().data.id).not.toBe(r2.json().data.id);
  });

  it('rejects an invalid Idempotency-Key', async () => {
    const { token } = createService(h, createUser(h));
    const res = await upload(token, 'x', '1', '?wait=true', { 'idempotency-key': 'a'.repeat(200) });
    expect(res.statusCode).toBe(400);
  });
});
