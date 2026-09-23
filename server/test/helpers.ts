import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { createContext, type AppContext } from '../src/context.js';
import { openDatabase, runMigrations } from '../src/database/client.js';
import { destinations, type Destination, type Service, type User } from '../src/database/schema.js';
import { newId } from '../src/lib/ids.js';
import type { NotificationMessage, NotificationProvider, NotificationTarget } from '../src/services/providers.js';
import { TelegramApiError, type ChatMemberInfo, type TelegramChatInfo, type TelegramGateway } from '../src/telegram/gateway.js';

export const BOT_TOKEN = '123456:TEST-bot-token';
export const ADMIN_TELEGRAM_ID = 1000;

export class FakeTelegram implements TelegramGateway {
  messages: Array<{ chatId: number; text: string; threadId?: number | null }> = [];
  documents: Array<{ chatId: number; filename: string; caption?: string; threadId?: number | null; content: Buffer }> = [];
  failDocumentsWith: TelegramApiError | undefined;
  chats = new Map<number, TelegramChatInfo>();
  members = new Map<string, ChatMemberInfo>();
  private nextId = 1;

  async sendMessage(chatId: number, text: string, opts: { threadId?: number | null } = {}) {
    this.messages.push({ chatId, text, threadId: opts.threadId });
    return { messageId: this.nextId++ };
  }

  async sendDocument(chatId: number, file: { path: string; filename: string }, opts: { threadId?: number | null; caption?: string } = {}) {
    if (this.failDocumentsWith) throw this.failDocumentsWith;
    // Read now: the temp file is deleted right after delivery.
    this.documents.push({ chatId, filename: file.filename, caption: opts.caption, threadId: opts.threadId, content: fs.readFileSync(file.path) });
    return { messageId: this.nextId++ };
  }

  async getChat(chatId: number) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new TelegramApiError('Bad Request: chat not found', 400);
    return chat;
  }

  async getChatMember(chatId: number, userId: number) {
    return this.members.get(`${chatId}:${userId}`) ?? { status: 'left' as const };
  }

  async getBotId() {
    return 42;
  }
}

export class FakeNotifier implements NotificationProvider {
  sent: Array<{ target: NotificationTarget; message: NotificationMessage }> = [];

  async notify(target: NotificationTarget, message: NotificationMessage) {
    this.sent.push({ target, message });
    return true;
  }

  ofKind(kind: NotificationMessage['kind']) {
    return this.sent.filter((s) => s.message.kind === kind);
  }
}

export interface TestHarness {
  app: FastifyInstance;
  ctx: AppContext;
  telegram: FakeTelegram;
  notifier: FakeNotifier;
  clock: { now: () => Date; advance: (ms: number) => void };
  close: () => Promise<void>;
}

export async function createHarness(env: Record<string, string> = {}): Promise<TestHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyb-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    DATA_DIR: dataDir,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    ADMIN_TELEGRAM_ID: String(ADMIN_TELEGRAM_ID),
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    LOG_LEVEL: 'silent',
    WEBAPP_DIST: path.join(dataDir, 'no-webapp'),
    ...env,
  });
  const db = openDatabase(':memory:');
  runMigrations(db);

  let nowMs = Date.now();
  const clock = { now: () => new Date(nowMs), advance: (ms: number) => void (nowMs += ms) };
  const telegram = new FakeTelegram();
  const notifier = new FakeNotifier();
  const ctx = createContext({ config, db, logger: pino({ level: 'silent' }), telegram, notifier, now: clock.now });
  const app = await buildApp(ctx);
  await app.ready();

  return {
    app,
    ctx,
    telegram,
    notifier,
    clock,
    close: async () => {
      await app.close();
      await ctx.backupQueue.onIdle();
      db.$client.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

let telegramIdSeq = 5000;

export function createUser(h: TestHarness, telegramId = telegramIdSeq++): User {
  return h.ctx.users.upsertFromTelegram({ id: telegramId, first_name: `User${telegramId}`, username: `user${telegramId}` });
}

export function sessionHeaders(h: TestHarness, user: User) {
  return { authorization: `Bearer ${h.app.jwt.sign({ sub: user.id, tid: user.telegramId })}` };
}

export function createVerifiedDestination(h: TestHarness, user: User, chatId = user.telegramId): Destination {
  return h.ctx.db
    .insert(destinations)
    .values({ id: newId(), userId: user.id, name: 'Test chat', type: 'PRIVATE_CHAT', telegramChatId: chatId, verified: true })
    .returning()
    .get();
}

export function createService(
  h: TestHarness,
  user: User,
  opts: { name?: string; destination?: Destination | null; healthEnabled?: boolean; interval?: number; grace?: number } = {},
): { service: Service; token: string } {
  const destination = opts.destination === undefined ? createVerifiedDestination(h, user) : opts.destination;
  return h.ctx.services.create(user, {
    name: opts.name ?? 'Production API',
    destinationId: destination?.id ?? null,
    healthEnabled: opts.healthEnabled ?? false,
    healthIntervalSeconds: opts.interval ?? 60,
    healthGraceSeconds: opts.grace ?? 30,
  });
}

export function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

export function multipart(filename: string, content: Buffer | string, field = 'file') {
  const boundary = `----gyb${newId(8)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
