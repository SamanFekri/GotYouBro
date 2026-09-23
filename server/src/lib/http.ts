import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { RateLimitResult } from '../rate-limit/rate-limit.js';

export function ok<T>(reply: FastifyReply, data: T, status = 200) {
  return reply.status(status).send({ success: true, data });
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Invalid request',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export const idParam = z.object({ id: z.string().min(1).max(64) });

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** Set standard rate limit headers and throw RATE_LIMITED if the request was rejected. */
export function enforceRateLimit(reply: FastifyReply, result: RateLimitResult, message = 'Too many requests'): void {
  if (result.limit !== undefined) {
    reply.header('X-RateLimit-Limit', result.limit);
    reply.header('X-RateLimit-Remaining', Math.max(0, result.remaining ?? 0));
    if (result.resetAt) reply.header('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));
  }
  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil(((result.resetAt ?? Date.now()) - Date.now()) / 1000));
    throw new AppError('RATE_LIMITED', message, undefined, { 'Retry-After': String(retryAfter) });
  }
}
