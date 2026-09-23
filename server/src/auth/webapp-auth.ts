import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AppContext } from '../context.js';
import type { User } from '../database/schema.js';
import { AppError } from '../lib/errors.js';
import { enforceRateLimit } from '../lib/http.js';
import './types.js';

/**
 * Web App session guard. The JWT only carries the internal user id; the user row is re-loaded on
 * every request so blocking and role changes take effect immediately.
 */
export function requireUser(ctx: AppContext): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('UNAUTHORIZED', 'Missing session token');
    let payload: { sub: string };
    try {
      payload = await request.jwtVerify<{ sub: string; tid: number }>();
    } catch {
      throw new AppError('UNAUTHORIZED', 'Session is invalid or expired');
    }
    const user = ctx.users.getById(payload.sub);
    if (!user) throw new AppError('UNAUTHORIZED', 'Session is invalid or expired');
    if (user.blocked) throw new AppError('USER_BLOCKED', 'Your account has been blocked');
    enforceRateLimit(reply, ctx.limiter.consume([ctx.limits.webappCheck(user.id)]));
    request.currentUser = user;
    request.isAdmin = ctx.users.isAdmin(user);
  };
}

export function requireAdmin(ctx: AppContext): preHandlerHookHandler[] {
  return [
    requireUser(ctx),
    async (request: FastifyRequest) => {
      if (!request.isAdmin) throw new AppError('FORBIDDEN', 'Administrator access required');
    },
  ];
}

/** Narrow `request.currentUser` after `requireUser` has run. */
export function currentUser(request: FastifyRequest): User {
  if (!request.currentUser) throw new AppError('UNAUTHORIZED', 'Not authenticated');
  return request.currentUser;
}
