import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InitDataError, validateInitData } from '../../../auth/telegram-init-data.js';
import { currentUser, requireUser } from '../../../auth/webapp-auth.js';
import type { AppContext } from '../../../context.js';
import { BACKUP_STATUSES, type User } from '../../../database/schema.js';
import { AppError } from '../../../lib/errors.js';
import { idParam, ok, pagination, parse } from '../../../lib/http.js';
import { HISTORY_DAYS } from '../../../services/health.service.js';
import { MONITOR_KEY_PATTERN } from '../../../services/monitors.service.js';
import { toMonitorView, type ServiceView } from '../../../services/services.service.js';

const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(500).nullable();
const telegramId = z.coerce.number().int().refine((n) => n !== 0 && Math.abs(n) <= Number.MAX_SAFE_INTEGER, 'Invalid Telegram id');

const intervalSeconds = z.number().int().min(10).max(7 * 86400);
const graceSeconds = z.number().int().min(0).max(86400);
const serviceFields = {
  description: description.optional(),
  destinationId: z.string().max(64).nullable().optional(),
  apiEnabled: z.boolean().optional(),
};
const createServiceBody = z
  .object({
    name,
    ...serviceFields,
    // Optional: also create the service's "default" health monitor.
    healthEnabled: z.boolean().optional(),
    healthNotify: z.boolean().optional(),
    healthIntervalSeconds: intervalSeconds.optional(),
    healthGraceSeconds: graceSeconds.optional(),
  })
  .strict();
const monitorFields = {
  enabled: z.boolean().optional(),
  notify: z.boolean().optional(),
  intervalSeconds: intervalSeconds.optional(),
  graceSeconds: graceSeconds.optional(),
};
const createMonitorBody = z
  .object({
    name,
    key: z.string().trim().toLowerCase().regex(MONITOR_KEY_PATTERN, 'Use 1-40 lowercase letters, digits, "-" or "_"').optional(),
    ...monitorFields,
  })
  .strict();
const updateMonitorBody = z.object({ name: name.optional(), ...monitorFields }).strict();
const updateServiceBody = z
  .object({
    name: name.optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    ...serviceFields,
    // Backward compatible: applied to the service's "default" monitor.
    healthEnabled: z.boolean().optional(),
    healthNotify: z.boolean().optional(),
    healthIntervalSeconds: intervalSeconds.optional(),
    healthGraceSeconds: graceSeconds.optional(),
  })
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
  const isAdmin = ctx.users.isAdmin(user);
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
      /** null = unlimited (administrators). */
      maxServices: isAdmin ? null : limits.maxServices,
      maxMonitorsPerService: isAdmin ? null : ctx.settings.getDefaultLimits().maxMonitorsPerService,
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
        downServices: ctx.services.listForUser(user.id).filter((s) => s.healthStatus === 'DOWN'),
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
      return ok(reply, { ...withHistory(ctx, ctx.services.view(service)), healthEvents: ctx.health.serviceOutages(service.id, 20) });
    });

    secured.patch('/services/:id', async (request, reply) => {
      const user = currentUser(request);
      const { id } = parse(idParam, request.params);
      const { healthEnabled, healthNotify, healthIntervalSeconds, healthGraceSeconds, ...fields } = parse(updateServiceBody, request.body);
      const service = ctx.services.update(user, id, fields);
      if ([healthEnabled, healthNotify, healthIntervalSeconds, healthGraceSeconds].some((v) => v !== undefined)) {
        ctx.monitors.configureDefault(user, service, {
          enabled: healthEnabled,
          notify: healthNotify,
          intervalSeconds: healthIntervalSeconds,
          graceSeconds: healthGraceSeconds,
        });
      }
      return ok(reply, ctx.services.view(ctx.services.get(service.id)));
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
      const services = ctx.services.listForUser(user.id).map((s) => withHistory(ctx, s));
      return ok(reply, { historyDays: HISTORY_DAYS, services, events: ctx.health.recentOutagesForUser(user.id, 50) });
    });

    // -------------------------------------------------------------- Monitors

    secured.post('/services/:id/monitors', async (request, reply) => {
      const user = currentUser(request);
      const { id } = parse(idParam, request.params);
      const body = parse(createMonitorBody, request.body);
      const monitor = ctx.monitors.create(user, ctx.services.getOwned(user.id, id), body);
      return ok(reply, toMonitorView(monitor), 201);
    });

    secured.patch('/monitors/:id', async (request, reply) => {
      const { id } = parse(idParam, request.params);
      const body = parse(updateMonitorBody, request.body);
      return ok(reply, toMonitorView(ctx.monitors.update(currentUser(request).id, id, body)));
    });

    secured.delete('/monitors/:id', async (request, reply) => {
      const { id } = parse(idParam, request.params);
      ctx.monitors.delete(currentUser(request).id, id);
      return ok(reply, { deleted: true });
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

/** Attach each monitor's 7-day health history to a service view. */
function withHistory(ctx: AppContext, service: ServiceView) {
  const history = ctx.health.history(service.monitors);
  return { ...service, monitors: service.monitors.map((m) => ({ ...m, history: history.get(m.id) })) };
}
