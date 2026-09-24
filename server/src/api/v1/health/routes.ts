import type { FastifyInstance } from 'fastify';
import { authenticatedService, serviceAuth } from '../../../auth/service-auth.js';
import type { AppContext } from '../../../context.js';
import { ok } from '../../../lib/http.js';

export async function heartbeatRoutes(app: FastifyInstance, { ctx }: { ctx: AppContext }) {
  // Heartbeats carry no body. Accept (and ignore) whatever a client sends, e.g. `curl -d ''`
  // or HTTP libraries that add a form Content-Type, instead of failing with 415.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => {
    payload.resume();
    done(null);
  });

  /** Updates the service's current health state only — no per-heartbeat record is stored. */
  app.post('/health/heartbeat', { preHandler: serviceAuth(ctx, 'heartbeat') }, async (request, reply) => {
    const { service } = authenticatedService(request);
    const result = ctx.health.recordHeartbeat(service.id);
    return ok(reply, { serviceId: service.id, ...result });
  });
}
