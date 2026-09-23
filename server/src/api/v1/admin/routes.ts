import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../../../auth/webapp-auth.js';
import type { AppContext } from '../../../context.js';
import { BACKUP_STATUSES, SERVICE_STATUSES } from '../../../database/schema.js';
import { AppError } from '../../../lib/errors.js';
import { idParam, ok, pagination, parse } from '../../../lib/http.js';
import { isValidRateLimit } from '../../../rate-limit/rate-limit.js';
import { defaultLimitsSchema } from '../../../services/settings.service.js';

const rateLimitOverride = z
  .string()
  .trim()
  .max(32)
  .refine(isValidRateLimit, 'Invalid rate limit (e.g. "60/minute")')
  .nullable()
  .optional();

const userLimitsBody = z
  .object({
    maxServices: z.number().int().min(0).max(10_000).nullable().optional(),
    maxBackupSizeMb: z.number().int().min(1).max(4000).nullable().optional(),
    apiRateLimit: rateLimitOverride,
    backupRateLimit: rateLimitOverride,
  })
  .strict();

const serviceLimitsBody = z
  .object({
    maxBackupSizeMb: z.number().int().min(1).max(4000).nullable().optional(),
    apiRateLimit: rateLimitOverride,
    backupRateLimit: rateLimitOverride,
    heartbeatRateLimit: rateLimitOverride,
  })
  .strict();

/** All routes require an admin, determined server-side from the database / ADMIN_TELEGRAM_ID. */
export async function adminRoutes(app: FastifyInstance, { ctx }: { ctx: AppContext }) {
  for (const hook of requireAdmin(ctx)) app.addHook('preHandler', hook);

  app.get('/stats', async (_request, reply) =>
    ok(reply, { ...ctx.stats.system(), queue: ctx.backupQueue.size, uptimeSeconds: Math.round(process.uptime()) }),
  );

  // ---------------------------------------------------------------- Users

  app.get('/users', async (request, reply) => {
    const query = parse(
      pagination.extend({
        q: z.string().trim().max(100).optional(),
        blocked: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
      }),
      request.query,
    );
    const { items, total } = ctx.users.list(query);
    return ok(reply, {
      total,
      items: items.map(({ user, serviceCount }) => ({ ...user, isAdmin: ctx.users.isAdmin(user), isRootAdmin: ctx.users.isRootAdmin(user), serviceCount })),
    });
  });

  app.get('/users/:id', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const user = ctx.users.require(id);
    return ok(reply, {
      user: { ...user, isAdmin: ctx.users.isAdmin(user), isRootAdmin: ctx.users.isRootAdmin(user) },
      effectiveLimits: ctx.limits.forUser(user),
      services: ctx.services.listForUser(user.id),
      destinations: ctx.destinations.list(user.id),
      recentBackups: ctx.backups.list({ userId: user.id }, { limit: 20, offset: 0 }).items,
    });
  });

  app.post('/users/:id/block', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(300).optional() }), request.body);
    const actor = currentUser(request);
    if (actor.id === id) throw new AppError('FORBIDDEN', 'You cannot block yourself');
    const target = ctx.users.require(id);
    if (ctx.users.isAdmin(target) && !ctx.users.isRootAdmin(actor)) {
      throw new AppError('FORBIDDEN', 'Only the root admin can block administrators');
    }
    const user = ctx.users.setBlocked(target, true, reason);
    ctx.audit.log({ actorUserId: actor.id, action: 'user.block', targetType: 'user', targetId: id, metadata: { reason }, ip: request.ip });
    return ok(reply, user);
  });

  app.post('/users/:id/unblock', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const user = ctx.users.setBlocked(ctx.users.require(id), false);
    ctx.audit.log({ actorUserId: currentUser(request).id, action: 'user.unblock', targetType: 'user', targetId: id, ip: request.ip });
    return ok(reply, user);
  });

  app.patch('/users/:id/limits', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const body = parse(userLimitsBody, request.body);
    ctx.users.require(id);
    const user = ctx.users.updateLimits(id, body);
    ctx.audit.log({ actorUserId: currentUser(request).id, action: 'user.limits', targetType: 'user', targetId: id, metadata: body, ip: request.ip });
    return ok(reply, { user, effectiveLimits: ctx.limits.forUser(user) });
  });

  /** Only the root admin (ADMIN_TELEGRAM_ID) may grant or revoke admin rights. */
  app.patch('/users/:id/role', async (request, reply) => {
    const actor = currentUser(request);
    if (!ctx.users.isRootAdmin(actor)) throw new AppError('FORBIDDEN', 'Only the root admin can change roles');
    const { id } = parse(idParam, request.params);
    const { role } = parse(z.object({ role: z.enum(['USER', 'ADMIN']) }), request.body);
    const user = ctx.users.setRole(ctx.users.require(id), role);
    ctx.audit.log({ actorUserId: actor.id, action: 'user.role', targetType: 'user', targetId: id, metadata: { role }, ip: request.ip });
    return ok(reply, user);
  });

  // ---------------------------------------------------------------- Services

  app.get('/services', async (request, reply) => {
    const query = parse(
      pagination.extend({
        q: z.string().trim().max(100).optional(),
        userId: z.string().max(64).optional(),
        status: z.enum(SERVICE_STATUSES).optional(),
      }),
      request.query,
    );
    return ok(reply, ctx.services.adminList(query));
  });

  /** Enable (ACTIVE) or suspend (SUSPENDED) a service. Users cannot lift a suspension. */
  app.patch('/services/:id/status', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }), request.body);
    const service = ctx.services.adminSetStatus(id, status);
    ctx.audit.log({
      actorUserId: currentUser(request).id,
      action: status === 'SUSPENDED' ? 'service.suspend' : 'service.enable',
      targetType: 'service',
      targetId: id,
      ip: request.ip,
    });
    return ok(reply, ctx.services.view(service));
  });

  app.patch('/services/:id/limits', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const body = parse(serviceLimitsBody, request.body);
    const service = ctx.services.adminSetLimits(id, body);
    ctx.audit.log({ actorUserId: currentUser(request).id, action: 'service.limits', targetType: 'service', targetId: id, metadata: body, ip: request.ip });
    return ok(reply, ctx.services.view(service));
  });

  // ---------------------------------------------------------------- Backups / health

  app.get('/backups', async (request, reply) => {
    const query = parse(
      pagination.extend({
        userId: z.string().max(64).optional(),
        serviceId: z.string().max(64).optional(),
        status: z.enum(BACKUP_STATUSES).optional(),
      }),
      request.query,
    );
    return ok(reply, ctx.backups.list({ userId: query.userId }, query));
  });

  // ---------------------------------------------------------------- Settings

  app.get('/settings/limits', async (_request, reply) =>
    ok(reply, { limits: ctx.settings.getDefaultLimits(), envDefaults: ctx.settings.envDefaults() }),
  );

  app.put('/settings/limits', async (request, reply) => {
    const body = parse(defaultLimitsSchema.partial().strict(), request.body);
    const limits = ctx.settings.updateDefaultLimits(body);
    ctx.audit.log({ actorUserId: currentUser(request).id, action: 'settings.limits', metadata: body, ip: request.ip });
    return ok(reply, { limits, envDefaults: ctx.settings.envDefaults() });
  });

  app.delete('/settings/limits', async (request, reply) => {
    const limits = ctx.settings.resetDefaultLimits();
    ctx.audit.log({ actorUserId: currentUser(request).id, action: 'settings.limits.reset', ip: request.ip });
    return ok(reply, { limits, envDefaults: ctx.settings.envDefaults() });
  });

  app.get('/audit-logs', async (request, reply) => {
    const query = parse(pagination, request.query);
    return ok(reply, ctx.audit.list(query.limit, query.offset));
  });
}
