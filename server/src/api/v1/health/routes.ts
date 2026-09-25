import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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

  /**
   * Updates a monitor's current health state only — no per-heartbeat record is stored.
   * `/health/heartbeat` targets the service's "default" monitor (or its only monitor);
   * `/health/heartbeat/<key>` targets a specific monitor.
   */
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { service } = authenticatedService(request);
    const key = (request.params as { monitor?: string }).monitor;
    if (!key) ctx.monitors.ensureDefaultForHeartbeat(service); // backward compatible keyless heartbeat
    const result = ctx.health.recordHeartbeat(service.id, key);
    return ok(reply, { serviceId: service.id, ...result });
  };
  app.post('/health/heartbeat', { preHandler: serviceAuth(ctx, 'heartbeat') }, handler);
  app.post('/health/heartbeat/:monitor', { preHandler: serviceAuth(ctx, 'heartbeat') }, handler);
}
