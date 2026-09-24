import fs from 'node:fs';
import { Telegram, TelegramError } from 'telegraf';

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel';

export interface TelegramChatInfo {
  id: number;
  type: TelegramChatType;
  title?: string;
  isForum: boolean;
}

export type ChatMemberStatus = 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';

export interface ChatMemberInfo {
  status: ChatMemberStatus;
  canPostMessages?: boolean;
}

export interface SendOptions {
  threadId?: number | null;
  html?: boolean;
}

/** Normalized Telegram API failure. */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    /** True when the Bot API server could not be reached at all (DNS, refused, timeout). */
    readonly unreachable = false,
    /** Set when a basic group was upgraded to a supergroup: the chat now has this new id. */
    readonly migrateToChatId?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }

  get retryable(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }

  get chatNotFound(): boolean {
    return /chat not found/i.test(this.message);
  }
}

/**
 * The minimal Telegram surface the core needs. Keeping it this small makes it trivial to fake in
 * tests and keeps Telegraf types out of business logic.
 */
export interface TelegramGateway {
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<{ messageId: number }>;
  sendDocument(
    chatId: number,
    file: { path: string; filename: string },
    opts?: SendOptions & { caption?: string },
  ): Promise<{ messageId: number }>;
  getChat(chatId: number): Promise<TelegramChatInfo>;
  getChatMember(chatId: number, userId: number): Promise<ChatMemberInfo>;
  getBotId(): Promise<number>;
}

export class TelegrafGateway implements TelegramGateway {
  private botId: number | undefined;
  private readonly wrap: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    readonly telegram: Telegram,
    apiRoot = 'https://api.telegram.org',
  ) {
    this.wrap = (fn) => wrap(fn, apiRoot);
  }

  static create(token: string, apiRoot?: string): TelegrafGateway {
    return new TelegrafGateway(new Telegram(token, apiRoot ? { apiRoot } : {}), apiRoot);
  }

  async sendMessage(chatId: number, text: string, opts: SendOptions = {}) {
    return this.wrap(async () => {
      const msg = await this.telegram.sendMessage(chatId, text, {
        ...(opts.threadId ? { message_thread_id: opts.threadId } : {}),
        ...(opts.html ? { parse_mode: 'HTML' as const } : {}),
        link_preview_options: { is_disabled: true },
      });
      return { messageId: msg.message_id };
    });
  }

  async sendDocument(chatId: number, file: { path: string; filename: string }, opts: SendOptions & { caption?: string } = {}) {
    return this.wrap(async () => {
      const msg = await this.telegram.sendDocument(
        chatId,
        { source: fs.createReadStream(file.path), filename: file.filename },
        {
          ...(opts.threadId ? { message_thread_id: opts.threadId } : {}),
          ...(opts.caption ? { caption: opts.caption } : {}),
          ...(opts.html ? { parse_mode: 'HTML' as const } : {}),
          disable_content_type_detection: true,
        },
      );
      return { messageId: msg.message_id };
    });
  }

  async getChat(chatId: number): Promise<TelegramChatInfo> {
    return this.wrap(async () => {
      const chat = await this.telegram.getChat(chatId);
      return {
        id: chat.id,
        type: chat.type,
        title: 'title' in chat ? chat.title : undefined,
        isForum: 'is_forum' in chat && chat.is_forum === true,
      };
    });
  }

  async getChatMember(chatId: number, userId: number): Promise<ChatMemberInfo> {
    return this.wrap(async () => {
      const member = await this.telegram.getChatMember(chatId, userId);
      return {
        status: member.status,
        canPostMessages: member.status === 'creator' || ('can_post_messages' in member && member.can_post_messages === true),
      };
    });
  }

  async getBotId(): Promise<number> {
    if (this.botId === undefined) this.botId = (await this.wrap(() => this.telegram.getMe())).id;
    return this.botId;
  }
}

async function wrap<T>(fn: () => Promise<T>, apiRoot: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TelegramError) {
      throw new TelegramApiError(err.description, err.code, err.parameters?.retry_after, false, err.parameters?.migrate_to_chat_id);
    }
    // Network-level failure. The raw message contains the request URL (with the bot id), so
    // only keep the reason, e.g. "getaddrinfo ENOTFOUND telegram-bot-api".
    const raw = err instanceof Error ? err.message : String(err);
    const reason = /reason: (.*)$/.exec(raw)?.[1] ?? (err as { code?: string }).code ?? 'network error';
    throw new TelegramApiError(`Cannot reach the Telegram Bot API at ${apiRoot} (${reason})`, undefined, undefined, true);
  }
}

/** Used when no bot token is configured (e.g. local API-only development). */
export class DisabledGateway implements TelegramGateway {
  private fail(): never {
    throw new TelegramApiError('Telegram bot is not configured (TELEGRAM_BOT_TOKEN missing)', 503);
  }
  async sendMessage(): Promise<{ messageId: number }> {
    this.fail();
  }
  async sendDocument(): Promise<{ messageId: number }> {
    this.fail();
  }
  async getChat(): Promise<TelegramChatInfo> {
    this.fail();
  }
  async getChatMember(): Promise<ChatMemberInfo> {
    this.fail();
  }
  async getBotId(): Promise<number> {
    this.fail();
  }
}
