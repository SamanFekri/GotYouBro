import type { FastifyInstance } from 'fastify';
import { authenticatedService, serviceAuth } from '../../../auth/service-auth.js';
import type { AppContext } from '../../../context.js';
import { ok } from '../../../lib/http.js';

export async function serviceInfoRoutes(app: FastifyInstance, { ctx }: { ctx: AppContext }) {
  /** Lets a client check its token and see which service/limits it maps to. */
  app.get('/service', { preHandler: serviceAuth(ctx, 'api') }, async (request, reply) => {
    const { service, user, credential } = authenticatedService(request);
    const limits = ctx.limits.forUser(user, service);
    const view = ctx.services.view(service);
    return ok(reply, {
      id: service.id,
      name: service.name,
      status: service.status,
      // Backward compatible fields (from the default monitor), plus the full monitor list.
      healthEnabled: view.healthEnabled,
      healthStatus: view.healthStatus,
      healthIntervalSeconds: view.healthIntervalSeconds,
      healthGraceSeconds: view.healthGraceSeconds,
      monitors: ctx.monitors.listForService(service.id).map((m) => ({
        key: m.key,
        name: m.name,
        enabled: m.enabled,
        status: m.status,
        intervalSeconds: m.intervalSeconds,
        graceSeconds: m.graceSeconds,
        heartbeatUrl: `/api/v1/health/heartbeat/${m.key}`,
      })),
      destinationConfigured: !!service.destinationId,
      token: { prefix: credential.tokenPrefix, createdAt: credential.createdAt },
      limits: {
        maxBackupBytes: limits.maxBackupBytes,
        apiRateLimit: service.apiRateLimit ?? limits.apiRateLimit,
        backupRateLimit: service.backupRateLimit ?? limits.backupRateLimit,
        heartbeatRateLimit: limits.heartbeatRateLimit,
      },
    });
  });
}
