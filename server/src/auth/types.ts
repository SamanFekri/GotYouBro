import type { User } from '../database/schema.js';
import type { AuthenticatedService } from '../services/credentials.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireUser` from a verified Web App session. */
    currentUser?: User;
    isAdmin?: boolean;
    /** Set by `serviceAuth` from a verified API token. */
    serviceAuth?: AuthenticatedService;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; tid: number };
    user: { sub: string; tid: number };
  }
}

export {};
