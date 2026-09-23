import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../database/client.js';
import { destinations, services, type Destination, type DestinationType, type User } from '../database/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { TelegramApiError, type TelegramChatInfo, type TelegramGateway } from '../telegram/gateway.js';

const ADMIN_STATUSES = new Set(['creator', 'administrator']);

export interface NewDestinationInput {
  name: string;
  chatId: number;
  threadId?: number | null;
}

export class DestinationsService {
  constructor(
    private readonly db: Db,
    private readonly telegram: TelegramGateway,
    private readonly logger: Logger,
  ) {}

  list(userId: string) {
    return this.db
      .select({
        destination: destinations,
        serviceCount: sql<number>`(SELECT count(*) FROM ${services} WHERE ${services.destinationId} = ${destinations.id})`,
      })
      .from(destinations)
      .where(eq(destinations.userId, userId))
      .orderBy(asc(destinations.createdAt))
      .all()
      .map((r) => ({ ...r.destination, serviceCount: r.serviceCount }));
  }

  getOwned(userId: string, id: string): Destination {
    const dest = this.db
      .select()
      .from(destinations)
      .where(and(eq(destinations.id, id), eq(destinations.userId, userId)))
      .get();
    if (!dest) throw notFound('DESTINATION_NOT_FOUND', 'Destination');
    return dest;
  }

  findByChat(userId: string, chatId: number, threadId: number | null): Destination | undefined {
    return this.db
      .select()
      .from(destinations)
      .where(
        and(
          eq(destinations.userId, userId),
          eq(destinations.telegramChatId, chatId),
          threadId === null ? isNull(destinations.telegramThreadId) : eq(destinations.telegramThreadId, threadId),
        ),
      )
      .get();
  }

  /** The user's own private chat with the bot. Always allowed; verified by sending a test message. */
  async addPrivateChat(user: User): Promise<Destination> {
    const existing = this.findByChat(user.id, user.telegramId, null);
    const dest = existing ?? this.insert(user.id, { name: 'My private chat', chatId: user.telegramId }, 'PRIVATE_CHAT', false);
    return this.verify(user, dest);
  }

  /**
   * Manually add a destination by chat id (and optional topic id). Guards against users pointing
   * the bot at chats they don't control: the user must be an admin of the target chat.
   */
  async addManual(user: User, input: NewDestinationInput): Promise<Destination> {
    const threadId = input.threadId ?? null;
    if (this.findByChat(user.id, input.chatId, threadId)) {
      throw new AppError('CONFLICT', 'This destination already exists');
    }

    if (input.chatId > 0) {
      if (input.chatId !== user.telegramId) {
        throw new AppError('FORBIDDEN', 'You can only add your own private chat as a private destination');
      }
      if (threadId) throw new AppError('VALIDATION_ERROR', 'Private chats do not support topics');
      const dest = this.insert(user.id, { ...input, threadId: null }, 'PRIVATE_CHAT', false);
      return this.verify(user, dest);
    }

    const chat = await this.inspectChat(input.chatId);
    const type = resolveType(chat, threadId);
    await this.assertUserControlsChat(chat, user.telegramId);
    await this.assertBotCanPost(chat);

    const dest = this.insert(user.id, { ...input, threadId }, type, false);
    return this.verify(user, dest);
  }

  /**
   * Called by the bot when a user runs /connect in a group/topic or adds the bot to a channel.
   * The bot has already confirmed the context, so the destination is created (or re-verified).
   */
  async connectFromBot(user: User, chat: TelegramChatInfo, threadId: number | null): Promise<Destination> {
    const type = resolveType(chat, threadId);
    const name = chat.title ? (threadId ? `${chat.title} (topic ${threadId})` : chat.title) : `Chat ${chat.id}`;
    const existing = this.findByChat(user.id, chat.id, threadId);
    const dest = existing ?? this.insert(user.id, { name, chatId: chat.id, threadId }, type, false);
    return this.verify(user, dest);
  }

  /** Verify by actually sending a message. Updates the `verified` flag either way. */
  async verify(user: User, dest: Destination): Promise<Destination> {
    try {
      await this.telegram.sendMessage(
        dest.telegramChatId,
        `✅ GotYouBro destination "${dest.name}" is connected. Backups will be delivered here.`,
        { threadId: dest.telegramThreadId },
      );
    } catch (err) {
      this.setVerified(dest.id, false);
      const reason = err instanceof TelegramApiError ? err.message : 'unknown error';
      this.logger.info({ destinationId: dest.id, userId: user.id, reason }, 'Destination verification failed');
      throw new AppError('DESTINATION_VERIFICATION_FAILED', `The bot could not send a message to this destination: ${reason}`);
    }
    return this.setVerified(dest.id, true);
  }

  rename(userId: string, id: string, name: string): Destination {
    this.getOwned(userId, id);
    return this.db.update(destinations).set({ name }).where(eq(destinations.id, id)).returning().get();
  }

  delete(userId: string, id: string): void {
    this.getOwned(userId, id);
    // services.destination_id / backups.destination_id are ON DELETE SET NULL.
    this.db.delete(destinations).where(eq(destinations.id, id)).run();
  }

  markUnverified(id: string): void {
    this.setVerified(id, false);
  }

  private setVerified(id: string, verified: boolean): Destination {
    return this.db
      .update(destinations)
      .set({ verified, verifiedAt: verified ? new Date() : null })
      .where(eq(destinations.id, id))
      .returning()
      .get();
  }

  private insert(userId: string, input: NewDestinationInput, type: DestinationType, verified: boolean): Destination {
    const now = new Date();
    return this.db
      .insert(destinations)
      .values({
        id: newId(),
        userId,
        name: input.name,
        type,
        telegramChatId: input.chatId,
        telegramThreadId: input.threadId ?? null,
        verified,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  private async inspectChat(chatId: number): Promise<TelegramChatInfo> {
    try {
      return await this.telegram.getChat(chatId);
    } catch (err) {
      throw new AppError(
        'DESTINATION_VERIFICATION_FAILED',
        `The bot cannot access chat ${chatId}. Add the bot to the group/channel first. (${(err as Error).message})`,
      );
    }
  }

  private async assertUserControlsChat(chat: TelegramChatInfo, telegramUserId: number): Promise<void> {
    let status: string;
    try {
      status = (await this.telegram.getChatMember(chat.id, telegramUserId)).status;
    } catch {
      status = 'left';
    }
    if (!ADMIN_STATUSES.has(status)) {
      throw new AppError('FORBIDDEN', 'You must be an administrator of this chat to use it as a destination');
    }
  }

  private async assertBotCanPost(chat: TelegramChatInfo): Promise<void> {
    if (chat.type !== 'channel') return;
    const botId = await this.telegram.getBotId();
    const member = await this.telegram.getChatMember(chat.id, botId).catch(() => undefined);
    if (!member || !ADMIN_STATUSES.has(member.status) || !member.canPostMessages) {
      throw new AppError('DESTINATION_VERIFICATION_FAILED', 'The bot must be a channel administrator with permission to post messages');
    }
  }
}

export function resolveType(chat: TelegramChatInfo, threadId: number | null): DestinationType {
  switch (chat.type) {
    case 'private':
      return 'PRIVATE_CHAT';
    case 'channel':
      if (threadId) throw new AppError('VALIDATION_ERROR', 'Channels do not support topics');
      return 'CHANNEL';
    default:
      if (threadId) {
        if (!chat.isForum) throw new AppError('VALIDATION_ERROR', 'This group does not have topics enabled');
        return 'GROUP_TOPIC';
      }
      return 'GROUP';
  }
}
