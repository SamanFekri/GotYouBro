import type { FastifyInstance } from 'fastify';
import { authenticatedService, serviceAuth } from '../../../auth/service-auth.js';
import type { AppContext } from '../../../context.js';
import { ok } from '../../../lib/http.js';

export async function heartbeatRoutes(app: FastifyInstance, { ctx }: { ctx: AppContext }) {
  /** Updates the service's current health state only — no per-heartbeat record is stored. */
  app.post('/health/heartbeat', { preHandler: serviceAuth(ctx, 'heartbeat') }, async (request, reply) => {
    const { service } = authenticatedService(request);
    const result = ctx.health.recordHeartbeat(service.id);
    return ok(reply, { serviceId: service.id, ...result });
  });
}
