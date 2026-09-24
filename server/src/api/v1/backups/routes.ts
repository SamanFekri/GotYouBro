import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticatedService, serviceAuth } from '../../../auth/service-auth.js';
import type { AppContext } from '../../../context.js';
import type { Backup } from '../../../database/schema.js';
import { AppError } from '../../../lib/errors.js';
import { sanitizeFilename, resolveInside } from '../../../lib/filenames.js';
import { idParam, ok, parse } from '../../../lib/http.js';
import { newId } from '../../../lib/ids.js';
import { toPublicBackup } from '../../../services/backups.service.js';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;
/** Allowance for multipart boundaries/headers when pre-checking Content-Length. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const uploadQuery = z.object({
  wait: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  filename: z.string().max(255).optional(),
});

interface ReceivedFile {
  path: string;
  filename: string;
  sizeBytes: number;
}

/**
 * Backup upload pipeline:
 *   auth → rate limit (preHandler) → validate service/destination → idempotency →
 *   stream to temp file with size limit → create RECEIVED record → queue delivery → respond.
 */
export async function backupRoutes(app: FastifyInstance, { ctx }: { ctx: AppContext }) {
  // Raw uploads: leave the body stream untouched so the handler can stream it to disk.
  app.addContentTypeParser('application/octet-stream', (_request, _payload, done) => done(null));

  app.post('/backups', { preHandler: serviceAuth(ctx, 'backup') }, async (request, reply) => {
    if (!request.isMultipart()) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Use multipart/form-data with a "file" field, or POST /backups/raw');
    const query = parse(uploadQuery, request.query);
    return handleUpload(ctx, request, reply, query.wait, async (maxBytes, tmpPath) => {
      assertContentLength(request, maxBytes + MULTIPART_OVERHEAD_BYTES);
      const part = await request.file({ limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 1024 } });
      if (!part) throw new AppError('INVALID_FILE', 'Missing file. Send it as the "file" form field.');
      const sizeBytes = await writeLimited(part.file, tmpPath, maxBytes);
      if (part.file.truncated) throw fileTooLarge(maxBytes);
      return { path: tmpPath, filename: sanitizeFilename(query.filename ?? part.filename), sizeBytes };
    });
  });

  app.post('/backups/raw', { preHandler: serviceAuth(ctx, 'backup') }, async (request, reply) => {
    const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/octet-stream') {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/octet-stream');
    }
    const query = parse(uploadQuery, request.query);
    const headerName = request.headers['x-filename'];
    const rawName = query.filename ?? (typeof headerName === 'string' ? safeDecode(headerName) : undefined);
    return handleUpload(ctx, request, reply, query.wait, async (maxBytes, tmpPath) => {
      assertContentLength(request, maxBytes);
      const sizeBytes = await writeLimited(request.raw, tmpPath, maxBytes);
      return { path: tmpPath, filename: sanitizeFilename(rawName), sizeBytes };
    });
  });

  app.get('/backups/:id', { preHandler: serviceAuth(ctx, 'api') }, async (request, reply) => {
    const { service } = authenticatedService(request);
    const { id } = parse(idParam, request.params);
    return ok(reply, toPublicBackup(ctx.backups.getForService(service.id, id)));
  });
}

async function handleUpload(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  wait: boolean,
  receive: (maxBytes: number, tmpPath: string) => Promise<ReceivedFile>,
) {
  const { service, user } = authenticatedService(request);

  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey) {
    const existing = ctx.backups.findByIdempotencyKey(service.id, idempotencyKey);
    // A failed attempt doesn't consume the key, so clients can simply retry with the same key.
    if (existing && existing.status === 'FAILED') ctx.backups.releaseIdempotencyKey(existing.id);
    else if (existing) return respondWithBackup(reply, existing, { idempotent: true });
  }

  const destination = ctx.backups.resolveDestination(service);
  const { maxBackupBytes } = ctx.limits.forUser(user, service);

  await fs.mkdir(ctx.config.tmpDir, { recursive: true });
  const tmpPath = resolveInside(ctx.config.tmpDir, `${newId(24)}.upload`);

  let file: ReceivedFile;
  let queued = false;
  try {
    file = await receive(maxBackupBytes, tmpPath);
    if (file.sizeBytes === 0) throw new AppError('INVALID_FILE', 'The uploaded file is empty');

    const { backup, duplicate } = ctx.backups.createRecord({
      service,
      user,
      destination,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      idempotencyKey,
    });
    if (duplicate) return respondWithBackup(reply, backup, { idempotent: true });

    request.log.info({ backupId: backup.id, sizeBytes: file.sizeBytes }, 'Backup received');
    const completion = ctx.backupQueue.enqueue(backup.id, tmpPath);
    queued = true;

    if (!wait) return respondWithBackup(reply, backup, { status: 202 });
    const final = await withTimeout(completion, ctx.config.backupWaitTimeoutSeconds * 1000);
    return respondWithBackup(reply, final ?? ctx.backups.getForService(service.id, backup.id), {});
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw fileTooLarge(maxBackupBytes);
    throw err;
  } finally {
    // The queue owns (and deletes) the file once enqueued; otherwise clean up here.
    if (!queued) await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

function respondWithBackup(reply: FastifyReply, backup: Backup, opts: { idempotent?: boolean; status?: number }) {
  const data = { ...toPublicBackup(backup), ...(opts.idempotent && { idempotent: true }) };
  if (backup.status === 'FAILED' && !opts.idempotent) {
    const code = backup.errorCode === 'DESTINATION_NOT_CONFIGURED' ? 'DESTINATION_NOT_CONFIGURED' : 'TELEGRAM_DELIVERY_FAILED';
    throw new AppError(code, backup.errorMessage ?? 'Backup delivery failed', { backup: data });
  }
  if (opts.idempotent) reply.header('Idempotent-Replayed', 'true');
  const status = opts.status ?? (backup.status === 'SUCCESS' ? 200 : 202);
  return ok(reply, data, status);
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new AppError('VALIDATION_ERROR', 'Idempotency-Key must be 1-128 printable ASCII characters');
  }
  return value;
}

function assertContentLength(request: FastifyRequest, maxBytes: number): void {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > maxBytes) throw fileTooLarge(maxBytes);
}

function fileTooLarge(maxBytes: number): AppError {
  return new AppError('FILE_TOO_LARGE', `File exceeds the maximum allowed size of ${Math.floor(maxBytes / 1024 / 1024)} MB`);
}

/** Stream to disk, aborting as soon as the byte limit is exceeded. Returns bytes written. */
async function writeLimited(source: Readable, target: string, maxBytes: number): Promise<number> {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(fileTooLarge(maxBytes));
      else cb(null, chunk);
    },
  });
  await pipeline(source, counter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  return size;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
