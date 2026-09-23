import type { FastifyInstance } from 'fastify';
import { authenticatedService, serviceAuth } from '../../../auth/service-auth.js';
import type { AppContext } from '../../../context.js';
import { ok } from '../../../lib/http.js';

export async function serviceInfoRoutes(app: FastifyInstance, { ctx }: { ctx: AppContext }) {
  /** Lets a client check its token and see which service/limits it maps to. */
  app.get('/service', { preHandler: serviceAuth(ctx, 'api') }, async (request, reply) => {
    const { service, user, credential } = authenticatedService(request);
    const limits = ctx.limits.forUser(user, service);
    return ok(reply, {
      id: service.id,
      name: service.name,
      status: service.status,
      healthEnabled: service.healthEnabled,
      healthStatus: service.healthStatus,
      healthIntervalSeconds: service.healthIntervalSeconds,
      healthGraceSeconds: service.healthGraceSeconds,
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
