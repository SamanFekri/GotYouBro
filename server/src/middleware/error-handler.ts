import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { AppError, type ErrorCode } from '../lib/errors.js';

function send(reply: FastifyReply, status: number, code: ErrorCode | string, message: string, details?: unknown) {
  return reply.status(status).send({ success: false, error: { code, message, ...(details !== undefined && { details }) } });
}

/** Map every failure to the `{ success: false, error: { code, message } }` envelope. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | ZodError | Error, request, reply) => {
    if (err instanceof AppError) {
      if (err.headers) reply.headers(err.headers);
      if (err.statusCode >= 500) request.log.error({ err }, err.message);
      return send(reply, err.statusCode, err.code, err.message, err.details);
    }
    if (err instanceof ZodError) {
      return send(reply, 400, 'VALIDATION_ERROR', 'Invalid request', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }

    const fe = err as FastifyError;
    switch (fe.code) {
      case 'FST_REQ_FILE_TOO_LARGE':
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        return send(reply, 413, 'FILE_TOO_LARGE', 'File exceeds the maximum allowed size');
      case 'FST_INVALID_MULTIPART_CONTENT_TYPE':
      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        return send(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported Content-Type');
      case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      case 'FST_ERR_CTP_INVALID_JSON_BODY':
        return send(reply, 400, 'VALIDATION_ERROR', 'Invalid JSON body');
    }
    if (fe.validation) return send(reply, 400, 'VALIDATION_ERROR', fe.message);
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return send(reply, fe.statusCode, fe.statusCode === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST', fe.message);
    }

    request.log.error({ err }, 'Unhandled error');
    return send(reply, 500, 'INTERNAL_ERROR', 'Internal server error');
  });
}

export function notFoundResponse(reply: FastifyReply, method: string, url: string) {
  return send(reply, 404, 'NOT_FOUND', `Route ${method} ${url.split('?')[0]} not found`);
}
