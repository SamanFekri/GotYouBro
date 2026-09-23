import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InitDataError, validateInitData } from '../../../auth/telegram-init-data.js';
import { currentUser, requireUser } from '../../../auth/webapp-auth.js';
import type { AppContext } from '../../../context.js';
import { BACKUP_STATUSES, type User } from '../../../database/schema.js';
import { AppError } from '../../../lib/errors.js';
import { idParam, ok, pagination, parse } from '../../../lib/http.js';

const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(500).nullable();
const telegramId = z.coerce.number().int().refine((n) => n !== 0 && Math.abs(n) <= Number.MAX_SAFE_INTEGER, 'Invalid Telegram id');

const serviceFields = {
  description: description.optional(),
  destinationId: z.string().max(64).nullable().optional(),
  apiEnabled: z.boolean().optional(),
  healthEnabled: z.boolean().optional(),
  healthNotify: z.boolean().optional(),
  healthIntervalSeconds: z.number().int().min(10).max(7 * 86400).optional(),
  healthGraceSeconds: z.number().int().min(0).max(86400).optional(),
};
const createServiceBody = z.object({ name, ...serviceFields }).strict();
const updateServiceBody = z
  .object({ name: name.optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), ...serviceFields })
  .strict();

const createDestinationBody = z
  .object({ name, chatId: telegramId, threadId: z.coerce.number().int().positive().nullable().optional() })
  .strict();

const backupQuery = pagination.extend({
  serviceId: z.string().max(64).optional(),
  status: z.enum(BACKUP_STATUSES).optional(),
});

export function meView(ctx: AppContext, user: User) {
  const limits = ctx.limits.forUser(user);
  return {
    id: user.id,
    telegramId: user.telegramId,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    isAdmin: ctx.users.isAdmin(user),
    isRootAdmin: ctx.users.isRootAdmin(user),
    notifyHealth: user.notifyHealth,
    notifyBackupFailures: user.notifyBackupFailures,
    limits: {
      maxServices: limits.maxServices,
      maxBackupBytes: limits.maxBackupBytes,
      apiRateLimit: limits.apiRateLimit,
      backupRateLimit: limits.backupRateLimit,
      heartbeatRateLimit: limits.heartbeatRateLimit,
    },
    serviceCount: ctx.services.countForUser(user.id),
  };
}

export async function webappRoutes(app: FastifyInstance, { ctx }: { ctx: AppContext }) {
  // ---------------------------------------------------------------- Auth

  /** Exchange Telegram Web App initData (HMAC-signed by Telegram) for a short-lived session token. */
  app.post('/auth', async (request, reply) => {
    const { initData } = parse(z.object({ initData: z.string().min(1).max(4096) }), request.body);
    const botToken = ctx.config.telegram.botToken;
    if (!botToken) throw new AppError('TELEGRAM_UNAVAILABLE', 'Telegram bot is not configured');

    let profile;
    try {
      profile = validateInitData(initData, botToken, ctx.config.initDataMaxAgeSeconds).user;
    } catch (err) {
      if (err instanceof InitDataError) {
        request.log.info({ reason: err.message }, 'Rejected Web App initData');
        throw new AppError('UNAUTHORIZED', 'Invalid Telegram authentication data');
      }
      throw err;
    }

    const user = ctx.users.upsertFromTelegram(profile);
    if (user.blocked) throw new AppError('USER_BLOCKED', 'Your account has been blocked');
    const token = app.jwt.sign({ sub: user.id, tid: user.telegramId }, { expiresIn: ctx.config.jwt.expiresIn });
    return ok(reply, { token, user: meView(ctx, user) });
  });

  // Everything below requires a valid session.
  app.register(async (secured) => {
    secured.addHook('preHandler', requireUser(ctx));

    // -------------------------------------------------------------- Me / settings / dashboard

    secured.get('/me', async (request, reply) => ok(reply, meView(ctx, currentUser(request))));

    secured.patch('/me/settings', async (request, reply) => {
      const body = parse(z.object({ notifyHealth: z.boolean().optional(), notifyBackupFailures: z.boolean().optional() }).strict(), request.body);
      const user = ctx.users.updateSettings(currentUser(request).id, body);
      return ok(reply, meView(ctx, user));
    });

    secured.get('/dashboard', async (request, reply) => {
      const user = currentUser(request);
      return ok(reply, {
        stats: ctx.stats.dashboard(user.id),
        recentBackups: ctx.backups.list({ userId: user.id }, { limit: 5, offset: 0 }).items,
        downServices: ctx.services.listForUser(user.id).filter((s) => s.healthEnabled && s.healthStatus === 'DOWN'),
      });
    });

    // -------------------------------------------------------------- Services

    secured.get('/services', async (request, reply) => ok(reply, ctx.services.listForUser(currentUser(request).id)));

    secured.post('/services', async (request, reply) => {
      const user = currentUser(request);
      const body = parse(createServiceBody, request.body);
      const { service, token } = ctx.services.create(user, body);
      ctx.audit.log({ actorUserId: user.id, action: 'service.create', targetType: 'service', targetId: service.id, ip: request.ip });
      ctx.audit.log({ actorUserId: user.id, action: 'token.create', targetType: 'service', targetId: service.id, ip: request.ip });
      return ok(reply, { service: ctx.services.view(service), token }, 201);
    });

    secured.get('/services/:id', async (request, reply) => {
      const { id } = parse(idParam, request.params);
      const service = ctx.services.getOwned(currentUser(request).id, id);
      return ok(reply, { ...ctx.services.view(service), healthEvents: ctx.health.events(service.id, 20) });
    });

    secured.patch('/services/:id', async (request, reply) => {
      const { id } = parse(idParam, request.params);
      const body = parse(updateServiceBody, request.body);
      const service = ctx.services.update(currentUser(request), id, body);
      return ok(reply, ctx.services.view(service));
    });

    secured.delete('/services/:id', async (request, reply) => {
      const user = currentUser(request);
      const { id } = parse(idParam, request.params);
      const service = ctx.services.delete(user, id);
      ctx.audit.log({ actorUserId: user.id, action: 'service.delete', targetType: 'service', targetId: service.id, metadata: { name: service.name }, ip: request.ip });
      return ok(reply, { deleted: true });
    });

    /** Generate a token, or rotate (revoke + replace) the existing one. The token is returned once. */
    secured.post('/services/:id/token', async (request, reply) => {
      const user = currentUser(request);
      const { id } = parse(idParam, request.params);
      const service = ctx.services.getOwned(user.id, id);
      const { token, credential, rotated } = ctx.credentials.issue(service.id);
      ctx.audit.log({
        actorUserId: user.id,
        action: rotated ? 'token.rotate' : 'token.create',
        targetType: 'service',
        targetId: service.id,
        metadata: { prefix: credential.tokenPrefix },
        ip: request.ip,
      });
      return ok(reply, { token, prefix: credential.tokenPrefix, createdAt: credential.createdAt }, 201);
    });

    secured.delete('/services/:id/token', async (request, reply) => {
      const user = currentUser(request);
      const { id } = parse(idParam, request.params);
      const service = ctx.services.getOwned(user.id, id);
      const revoked = ctx.credentials.revoke(service.id);
      if (revoked) ctx.audit.log({ actorUserId: user.id, action: 'token.revoke', targetType: 'service', targetId: service.id, ip: request.ip });
      return ok(reply, { revoked });
    });

    // -------------------------------------------------------------- Health

    secured.get('/health', async (request, reply) => {
      const user = currentUser(request);
      const services = ctx.services.listForUser(user.id).map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        healthEnabled: s.healthEnabled,
        healthNotify: s.healthNotify,
        healthStatus: s.healthStatus,
        healthIntervalSeconds: s.healthIntervalSeconds,
        healthGraceSeconds: s.healthGraceSeconds,
        lastHeartbeatAt: s.lastHeartbeatAt,
        wentDownAt: s.wentDownAt,
        lastRecoveredAt: s.lastRecoveredAt,
        totalDowntimeSeconds: s.totalDowntimeSeconds,
        downCount: s.downCount,
        uptimeSinceCreationPercent: uptimePercent(s.createdAt, s.totalDowntimeSeconds, s.wentDownAt),
      }));
      return ok(reply, { services, events: ctx.health.recentEventsForUser(user.id, 50) });
    });

    // -------------------------------------------------------------- Destinations

    secured.get('/destinations', async (request, reply) => ok(reply, ctx.destinations.list(currentUser(request).id)));

    secured.post('/destinations', async (request, reply) => {
      const body = parse(createDestinationBody, request.body);
      const dest = await ctx.destinations.addManual(currentUser(request), body);
      return ok(reply, dest, 201);
    });

    secured.post('/destinations/private', async (request, reply) => {
      const dest = await ctx.destinations.addPrivateChat(currentUser(request));
      return ok(reply, dest, 201);
    });

    secured.post('/destinations/:id/verify', async (request, reply) => {
      const user = currentUser(request);
      const { id } = parse(idParam, request.params);
      return ok(reply, await ctx.destinations.verify(user, ctx.destinations.getOwned(user.id, id)));
    });

    secured.patch('/destinations/:id', async (request, reply) => {
      const { id } = parse(idParam, request.params);
      const body = parse(z.object({ name }).strict(), request.body);
      return ok(reply, ctx.destinations.rename(currentUser(request).id, id, body.name));
    });

    secured.delete('/destinations/:id', async (request, reply) => {
      const { id } = parse(idParam, request.params);
      ctx.destinations.delete(currentUser(request).id, id);
      return ok(reply, { deleted: true });
    });

    // -------------------------------------------------------------- Backups

    secured.get('/backups', async (request, reply) => {
      const query = parse(backupQuery, request.query);
      return ok(reply, ctx.backups.list({ userId: currentUser(request).id }, query));
    });

    secured.get('/backups/:id', async (request, reply) => {
      const { id } = parse(idParam, request.params);
      return ok(reply, ctx.backups.getOwned(currentUser(request).id, id));
    });
  });
}

function uptimePercent(createdAt: Date, totalDowntimeSeconds: number, wentDownAt: Date | null): number {
  const now = Date.now();
  const lifetime = Math.max(1, (now - createdAt.getTime()) / 1000);
  const ongoing = wentDownAt ? (now - wentDownAt.getTime()) / 1000 : 0;
  return Math.max(0, Math.min(100, Math.round((1 - (totalDowntimeSeconds + ongoing) / lifetime) * 10000) / 100));
}
