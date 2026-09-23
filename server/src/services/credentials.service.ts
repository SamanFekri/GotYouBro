import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../database/client.js';
import { apiCredentials, services, users, type ApiCredential, type Service, type User } from '../database/schema.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { generateToken, hashToken, isWellFormedToken } from '../lib/tokens.js';

export interface AuthenticatedService {
  credential: ApiCredential;
  service: Service;
  user: User;
}

/** Only persist `last_used_at` occasionally so heartbeats don't cause an extra write each time. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export class CredentialsService {
  constructor(private readonly db: Db) {}

  active(serviceId: string): ApiCredential | undefined {
    return this.db
      .select()
      .from(apiCredentials)
      .where(and(eq(apiCredentials.serviceId, serviceId), isNull(apiCredentials.revokedAt)))
      .orderBy(desc(apiCredentials.createdAt))
      .get();
  }

  /**
   * Create a new token for a service, revoking any existing one (rotation).
   * The plaintext token is returned exactly once and never stored.
   */
  issue(serviceId: string): { token: string; credential: ApiCredential; rotated: boolean } {
    const generated = generateToken();
    return this.db.transaction((tx) => {
      const now = new Date();
      const revoked = tx
        .update(apiCredentials)
        .set({ revokedAt: now })
        .where(and(eq(apiCredentials.serviceId, serviceId), isNull(apiCredentials.revokedAt)))
        .run();
      const credential = tx
        .insert(apiCredentials)
        .values({ id: newId(), serviceId, tokenHash: generated.hash, tokenPrefix: generated.prefix, createdAt: now })
        .returning()
        .get();
      return { token: generated.token, credential, rotated: revoked.changes > 0 };
    });
  }

  revoke(serviceId: string): boolean {
    const result = this.db
      .update(apiCredentials)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiCredentials.serviceId, serviceId), isNull(apiCredentials.revokedAt)))
      .run();
    return result.changes > 0;
  }

  /**
   * Resolve a bearer token to its service and owner, enforcing credential, user and service state.
   * Checks are ordered so the most specific reason is reported.
   */
  authenticate(token: string): AuthenticatedService {
    if (!isWellFormedToken(token)) throw new AppError('INVALID_TOKEN', 'Invalid API token');
    const row = this.db
      .select({ credential: apiCredentials, service: services, user: users })
      .from(apiCredentials)
      .innerJoin(services, eq(services.id, apiCredentials.serviceId))
      .innerJoin(users, eq(users.id, services.userId))
      .where(eq(apiCredentials.tokenHash, hashToken(token)))
      .get();

    if (!row) throw new AppError('INVALID_TOKEN', 'Invalid API token');
    if (row.credential.revokedAt) throw new AppError('TOKEN_REVOKED', 'This API token has been revoked');
    if (row.user.blocked) throw new AppError('USER_BLOCKED', 'The owner of this service is blocked');
    if (row.service.status !== 'ACTIVE') {
      throw new AppError('SERVICE_DISABLED', row.service.status === 'SUSPENDED' ? 'Service is suspended by an administrator' : 'Service is disabled');
    }
    if (!row.service.apiEnabled) throw new AppError('SERVICE_DISABLED', 'API access is disabled for this service');

    this.touch(row.credential);
    return row;
  }

  private touch(credential: ApiCredential): void {
    const now = Date.now();
    if (credential.lastUsedAt && now - credential.lastUsedAt.getTime() < LAST_USED_WRITE_INTERVAL_MS) return;
    this.db.update(apiCredentials).set({ lastUsedAt: new Date(now) }).where(eq(apiCredentials.id, credential.id)).run();
  }
}
