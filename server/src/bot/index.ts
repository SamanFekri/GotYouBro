import { Markup, Telegraf, type Context } from 'telegraf';
import type { AppContext } from '../context.js';
import type { User } from '../database/schema.js';
import { AppError } from '../lib/errors.js';
import { escapeHtml, formatBytes, formatUtc } from '../lib/format.js';
import type { TelegramChatInfo } from '../telegram/gateway.js';

const HEALTH_ICON: Record<string, string> = { HEALTHY: '🟢', DOWN: '🔴', UNKNOWN: '⚪️' };

const COMMANDS = [
  { command: 'start', description: 'Start and open GotYouBro' },
  { command: 'dashboard', description: 'Open the dashboard' },
  { command: 'services', description: 'List your services' },
  { command: 'status', description: 'Health and backup summary' },
  { command: 'connect', description: 'Use this group/topic as a backup destination' },
  { command: 'help', description: 'How GotYouBro works' },
];

/**
 * The bot stays thin: identify users, open the Web App, help connect destinations and show a
 * quick status. All logic lives in the services on `AppContext`.
 */
export function registerBot(bot: Telegraf, app: AppContext): void {
  const webappUrl = app.config.webappUrl;
  const canUseWebApp = !!webappUrl && webappUrl.startsWith('https://');

  const openButton = (ctx: Context, label = '🚀 Open GotYouBro') => {
    if (!webappUrl) return undefined;
    // web_app buttons only work in private chats; groups get a plain link.
    if (ctx.chat?.type === 'private' && canUseWebApp) return Markup.inlineKeyboard([Markup.button.webApp(label, webappUrl)]);
    return Markup.inlineKeyboard([Markup.button.url(label, webappUrl)]);
  };

  const registeredUser = (ctx: Context): User | undefined => (ctx.from ? app.users.getByTelegramId(ctx.from.id) : undefined);

  bot.catch((err, ctx) => {
    app.logger.error({ err, updateType: ctx.updateType }, 'Bot handler failed');
  });

  // Telegram gives a group a new id when it becomes a supergroup (e.g. Topics enabled).
  bot.use(async (ctx, next) => {
    const msg = ctx.message;
    if (msg && 'migrate_to_chat_id' in msg && msg.migrate_to_chat_id) {
      app.destinations.migrateChat(msg.chat.id, msg.migrate_to_chat_id);
      return;
    }
    return next();
  });

  // Blocked users get a single notice and nothing else.
  bot.use(async (ctx, next) => {
    const user = registeredUser(ctx);
    if (user?.blocked) {
      if (ctx.chat?.type === 'private' && ctx.message) await ctx.reply('⛔️ Your GotYouBro account has been blocked.');
      return;
    }
    return next();
  });

  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const user = app.users.upsertFromTelegram(ctx.from);
    const isNew = app.destinations.list(user.id).length === 0;
    await ctx.replyWithHTML(
      [
        `👋 Hey ${escapeHtml(ctx.from.first_name)}, <b>GotYouBro</b> has your back.`,
        '',
        '📦 <b>Backups</b> — your apps POST files to the API and I deliver them to a chat, group, topic or channel.',
        '💓 <b>Health</b> — your apps send heartbeats; if they stop, I alert you once and again when they recover.',
        '',
        'Open the Web App to create a service and get an API token.',
      ].join('\n'),
      openButton(ctx),
    );
    if (isNew) {
      // Give new users a ready-to-use destination: this private chat.
      await app.destinations.addPrivateChat(user).catch((err) => app.logger.warn({ err: err.message }, 'Could not add private destination'));
    }
  });

  bot.help(async (ctx) => {
    await ctx.replyWithHTML(
      [
        '<b>GotYouBro commands</b>',
        '',
        '/dashboard — open the Web App',
        '/services — list your services',
        '/status — health & backup summary',
        '/connect — run inside a group or forum topic to deliver backups there',
        '',
        '<b>Channels:</b> add me as an admin with "Post messages" permission — the channel is connected automatically.',
        '',
        `API docs: ${escapeHtml((app.config.publicApiUrl ?? '') + '/api/docs')}`,
      ].join('\n'),
      openButton(ctx),
    );
  });

  bot.command('dashboard', async (ctx) => {
    await ctx.reply('Open your dashboard:', openButton(ctx, '📊 Dashboard'));
  });

  bot.command('services', async (ctx) => {
    const user = registeredUser(ctx);
    if (!user) return ctx.reply('Send /start first.');
    const services = app.services.listForUser(user.id);
    if (!services.length) return ctx.reply('You have no services yet. Create one in the Web App.', openButton(ctx));
    const lines = services.map((s) => {
      const health = s.healthEnabled ? `${HEALTH_ICON[s.healthStatus]} ${s.healthStatus.toLowerCase()}` : '— monitoring off';
      const state = s.status === 'ACTIVE' ? '' : ` <i>(${s.status.toLowerCase()})</i>`;
      return `• <b>${escapeHtml(s.name)}</b>${state}\n   ${health} · ${s.backupCount} backups`;
    });
    await ctx.replyWithHTML(['<b>Your services</b>', '', ...lines].join('\n'), openButton(ctx, 'Manage services'));
  });

  bot.command('status', async (ctx) => {
    const user = registeredUser(ctx);
    if (!user) return ctx.reply('Send /start first.');
    const s = app.stats.dashboard(user.id);
    const down = app.services.listForUser(user.id).filter((x) => x.healthEnabled && x.healthStatus === 'DOWN');
    const last = app.backups.list({ userId: user.id }, { limit: 1, offset: 0 }).items[0];
    await ctx.replyWithHTML(
      [
        '<b>Status</b>',
        '',
        `Services: ${s.totalServices} (${s.healthyServices} healthy, ${s.downServices} down)`,
        ...down.map((d) => `🔴 ${escapeHtml(d.name)}`),
        `Backups (7d): ${s.recentBackups} (${s.failedBackups} failed, ${formatBytes(s.recentBackupBytes)})`,
        last ? `Last backup: ${escapeHtml(last.filename)} — ${last.status} at ${formatUtc(last.createdAt)}` : 'No backups yet.',
      ].join('\n'),
    );
  });

  /** Run in a group, supergroup or forum topic to register it as a destination. */
  bot.command('connect', async (ctx) => {
    if (ctx.chat.type === 'private') {
      return ctx.reply('Run /connect inside the group or topic you want backups delivered to. For channels, add me as an admin.');
    }
    const user = registeredUser(ctx);
    if (!user) return ctx.reply('Please start me in a private chat first (/start), then run /connect again here.');
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).catch(() => undefined);
    if (!member || !['creator', 'administrator'].includes(member.status)) {
      return ctx.reply('Only group administrators can connect this chat.');
    }
    const msg = ctx.message;
    const threadId = 'is_topic_message' in msg && msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : null;
    const chat: TelegramChatInfo = {
      id: ctx.chat.id,
      type: ctx.chat.type,
      title: 'title' in ctx.chat ? ctx.chat.title : undefined,
      isForum: 'is_forum' in ctx.chat && ctx.chat.is_forum === true,
    };
    try {
      const dest = await app.destinations.connectFromBot(user, chat, threadId);
      await ctx.telegram
        .sendMessage(user.telegramId, `✅ Destination "${dest.name}" connected. Select it for a service in the Web App.`)
        .catch(() => undefined);
    } catch (err) {
      const message = err instanceof AppError ? err.message : 'Something went wrong';
      await ctx.reply(`❌ ${message}`, threadId ? { message_thread_id: threadId } : {});
    }
  });

  /** Channels can't run commands, so connect them when the bot is promoted to admin. */
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const status = update.new_chat_member.status;
    const chat = update.chat;
    if (status !== 'administrator' && status !== 'member') return;

    if (chat.type === 'channel') {
      if (status !== 'administrator') return;
      const user = app.users.getByTelegramId(update.from.id);
      if (!user) return;
      try {
        const dest = await app.destinations.connectFromBot(user, { id: chat.id, type: 'channel', title: chat.title, isForum: false }, null);
        await ctx.telegram.sendMessage(user.telegramId, `✅ Channel "${dest.name}" connected as a backup destination.`).catch(() => undefined);
      } catch (err) {
        app.logger.info({ chatId: chat.id, err: (err as Error).message }, 'Could not auto-connect channel');
        await ctx.telegram
          .sendMessage(user.telegramId, `⚠️ I was added to "${chat.title}" but can't post there yet. Make sure I have "Post messages" permission.`)
          .catch(() => undefined);
      }
    } else if ((chat.type === 'group' || chat.type === 'supergroup') && update.old_chat_member.status === 'left') {
      await ctx.telegram
        .sendMessage(chat.id, '👋 Hi! A group admin can run /connect here (or inside a topic) to receive backups in this chat.')
        .catch(() => undefined);
    }
  });
}

export async function configureBotProfile(bot: Telegraf, app: AppContext): Promise<void> {
  try {
    await bot.telegram.setMyCommands(COMMANDS);
    if (app.config.webappUrl?.startsWith('https://')) {
      await bot.telegram.setChatMenuButton({ menuButton: { type: 'web_app', text: 'Open', web_app: { url: app.config.webappUrl } } });
    }
  } catch (err) {
    app.logger.warn({ err: (err as Error).message }, 'Failed to configure bot commands/menu');
  }
}
