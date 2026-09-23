import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import type { AppConfig } from '../config/index.js';
import type { Db } from '../database/client.js';
import { services, users, type User, type UserRole } from '../database/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

export interface TelegramProfile {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface UserLimitOverrides {
  maxServices?: number | null;
  maxBackupSizeMb?: number | null;
  apiRateLimit?: string | null;
  backupRateLimit?: string | null;
}

export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  /** Admin status is always decided server-side: env root admin or an ADMIN role granted by the root admin. */
  isAdmin(user: Pick<User, 'role' | 'telegramId'>): boolean {
    return user.role === 'ADMIN' || this.isRootAdmin(user);
  }

  isRootAdmin(user: Pick<User, 'telegramId'>): boolean {
    return this.config.adminTelegramId !== undefined && user.telegramId === this.config.adminTelegramId;
  }

  upsertFromTelegram(profile: TelegramProfile): User {
    const now = new Date();
    const profileFields = {
      username: profile.username ?? null,
      firstName: profile.first_name ?? null,
      lastName: profile.last_name ?? null,
      lastSeenAt: now,
    };
    const existing = this.getByTelegramId(profile.id);
    if (existing) {
      return this.db.update(users).set(profileFields).where(eq(users.id, existing.id)).returning().get();
    }
    return this.db
      .insert(users)
      .values({
        id: newId(),
        telegramId: profile.id,
        ...profileFields,
        role: this.isRootAdmin({ telegramId: profile.id }) ? 'ADMIN' : 'USER',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: users.telegramId, set: profileFields })
      .returning()
      .get();
  }

  getById(id: string): User | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  getByTelegramId(telegramId: number): User | undefined {
    return this.db.select().from(users).where(eq(users.telegramId, telegramId)).get();
  }

  require(id: string): User {
    const user = this.getById(id);
    if (!user) throw notFound('USER_NOT_FOUND', 'User');
    return user;
  }

  updateSettings(userId: string, patch: { notifyHealth?: boolean; notifyBackupFailures?: boolean }): User {
    return this.db.update(users).set(patch).where(eq(users.id, userId)).returning().get();
  }

  // ---- Admin ----

  list(opts: { q?: string; blocked?: boolean; limit: number; offset: number }) {
    const conditions: SQL[] = [];
    if (opts.q) {
      const q = `%${opts.q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const numeric = /^\d+$/.test(opts.q) ? eq(users.telegramId, Number(opts.q)) : undefined;
      conditions.push(
        or(
          sql`${users.username} LIKE ${q} ESCAPE '\\'`,
          sql`${users.firstName} LIKE ${q} ESCAPE '\\'`,
          sql`${users.lastName} LIKE ${q} ESCAPE '\\'`,
          eq(users.id, opts.q),
          ...(numeric ? [numeric] : []),
        )!,
      );
    }
    if (opts.blocked !== undefined) conditions.push(eq(users.blocked, opts.blocked));
    const where = conditions.length ? and(...conditions) : undefined;

    const items = this.db
      .select({
        user: users,
        serviceCount: sql<number>`(SELECT count(*) FROM ${services} WHERE ${services.userId} = ${users.id})`,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .all();
    const total = this.db.select({ n: sql<number>`count(*)` }).from(users).where(where).get()?.n ?? 0;
    return { items, total };
  }

  setBlocked(target: User, blocked: boolean, reason?: string): User {
    if (blocked && this.isRootAdmin(target)) throw new AppError('FORBIDDEN', 'The root admin cannot be blocked');
    return this.db
      .update(users)
      .set({ blocked, blockedReason: blocked ? (reason ?? null) : null })
      .where(eq(users.id, target.id))
      .returning()
      .get();
  }

  updateLimits(userId: string, overrides: UserLimitOverrides): User {
    return this.db.update(users).set(overrides).where(eq(users.id, userId)).returning().get();
  }

  setRole(target: User, role: UserRole): User {
    if (this.isRootAdmin(target)) throw new AppError('FORBIDDEN', 'The root admin role cannot be changed');
    return this.db.update(users).set({ role }).where(eq(users.id, target.id)).returning().get();
  }
}
