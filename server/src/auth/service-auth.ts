import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { enforceRateLimit } from '../lib/http.js';
import type { LimitCategory } from '../rate-limit/limits.js';
import type { AuthenticatedService } from '../services/credentials.service.js';
import './types.js';

/**
 * Credential extractors, tried in order. Add new mechanisms (e.g. `X-API-Key`, signed requests)
 * here without touching route handlers.
 */
type TokenExtractor = (request: FastifyRequest) => string | undefined;

const bearerExtractor: TokenExtractor = (request) => {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(' ', 2);
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : undefined;
};

const extractors: TokenExtractor[] = [bearerExtractor];

/** Authenticate the service token, then apply the rate limits for the endpoint category. */
export function serviceAuth(ctx: AppContext, category: LimitCategory): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractors.map((extract) => extract(request)).find(Boolean);
    if (!token) throw new AppError('UNAUTHORIZED', 'Missing API token. Use "Authorization: Bearer <token>".');

    const auth = ctx.credentials.authenticate(token);
    request.serviceAuth = auth;
    request.log = request.log.child({ serviceId: auth.service.id, tokenPrefix: auth.credential.tokenPrefix });

    const monitorKey = (request.params as { monitor?: string } | undefined)?.monitor;
    const result = ctx.limiter.consume(ctx.limits.serviceApiChecks(auth.user, auth.service, category, monitorKey));
    enforceRateLimit(reply, result, category === 'backup' ? 'Backup rate limit exceeded' : 'Too many requests');
  };
}

export function authenticatedService(request: FastifyRequest): AuthenticatedService {
  if (!request.serviceAuth) throw new AppError('UNAUTHORIZED', 'Not authenticated');
  return request.serviceAuth;
}
