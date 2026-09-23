import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { adminRoutes } from './api/v1/admin/routes.js';
import { webappRoutes } from './api/v1/app/routes.js';
import { backupRoutes } from './api/v1/backups/routes.js';
import { heartbeatRoutes } from './api/v1/health/routes.js';
import { serviceInfoRoutes } from './api/v1/service/routes.js';
import { buildOpenApiDocument } from './api/openapi.js';
import type { AppContext } from './context.js';
import { isDatabaseReady } from './database/client.js';
import { newId } from './lib/ids.js';
import { enforceRateLimit, ok } from './lib/http.js';
import { AppError } from './lib/errors.js';
import { notFoundResponse, registerErrorHandling } from './middleware/error-handler.js';

const DEFAULT_WEBAPP_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../webapp/.output/public');

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { config } = ctx;

  const app = Fastify({
    loggerInstance: ctx.logger as FastifyBaseLogger,
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024, // JSON bodies; uploads stream separately with their own limits.
    genReqId: () => newId(12),
  });

  registerErrorHandling(app);

  await app.register(helmet, {
    // The Web App is embedded by Telegram clients (web.telegram.org uses an iframe).
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://telegram.org'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
  });

  // Browser access is only needed by the Web App; server-to-server API calls send no Origin.
  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Filename'],
    maxAge: 600,
  });

  await app.register(multipart, {
    limits: { fileSize: config.telegram.maxFileBytes, files: 1, fields: 10, parts: 12, fieldSize: 1024 },
  });

  await app.register(jwt, {
    secret: config.jwt.secret,
    sign: { algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  });

  // Per-IP limit on every API request (in addition to user/service limits).
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || request.url.startsWith('/api/docs')) return;
    enforceRateLimit(reply, ctx.limiter.consume([ctx.limits.ipCheck(request.ip)]));
  });

  // ------------------------------------------------------------------ System

  app.get('/health', async (_request, reply) => ok(reply, { status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));

  app.get('/ready', async (_request, reply) => {
    if (!isDatabaseReady(ctx.db)) throw new AppError('NOT_READY', 'Database unavailable');
    return ok(reply, { status: 'ready', database: 'ok', queue: ctx.backupQueue.size });
  });

  // ------------------------------------------------------------------ API v1

  await app.register(
    async (v1) => {
      await v1.register(backupRoutes, { ctx });
      await v1.register(heartbeatRoutes, { ctx });
      await v1.register(serviceInfoRoutes, { ctx });
      await v1.register(webappRoutes, { ctx, prefix: '/app' });
      await v1.register(adminRoutes, { ctx, prefix: '/admin' });
    },
    { prefix: '/api/v1' },
  );

  // ------------------------------------------------------------------ Docs

  await app.register(swagger, { mode: 'static', specification: { document: buildOpenApiDocument(config.publicApiUrl) as never } });
  await app.register(swaggerUi, { routePrefix: '/api/docs', uiConfig: { docExpansion: 'list', deepLinking: true } });

  // ------------------------------------------------------------------ Web App (static SPA)

  const webappDist = config.webappDist ? path.resolve(config.webappDist) : DEFAULT_WEBAPP_DIST;
  let spaEntry: string | undefined;
  if (fs.existsSync(path.join(webappDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webappDist, prefix: '/', wildcard: false, index: ['index.html'] });
    spaEntry = fs.existsSync(path.join(webappDist, '200.html')) ? '200.html' : 'index.html';
    ctx.logger.info({ webappDist }, 'Serving Web App');
  } else {
    ctx.logger.info({ webappDist }, 'Web App build not found; serving API only');
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0]!;
    // Client-side routes of the SPA (e.g. /services/abc) fall back to the SPA entry page.
    if (spaEntry && request.method === 'GET' && !pathname.startsWith('/api/') && !path.extname(pathname)) {
      return reply.header('Cache-Control', 'no-cache').sendFile(spaEntry);
    }
    return notFoundResponse(reply, request.method, request.url);
  });

  return app;
}
