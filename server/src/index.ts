import fs from 'node:fs';
import { Telegraf } from 'telegraf';
import { buildApp } from './app.js';
import { configureBotProfile, registerBot } from './bot/index.js';
import { loadConfig } from './config/index.js';
import { createContext } from './context.js';
import { openDatabase, runMigrations } from './database/client.js';
import { createLogger } from './lib/logger.js';
import { DisabledGateway, TelegrafGateway, type TelegramGateway } from './telegram/gateway.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);

  const db = openDatabase(config.databaseFile);
  runMigrations(db);
  logger.info({ database: config.databaseFile }, 'Database ready');

  // Temp uploads from a previous run are orphaned; their backups are marked failed below.
  fs.rmSync(config.tmpDir, { recursive: true, force: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });

  let bot: Telegraf | undefined;
  let telegram: TelegramGateway;
  if (config.telegram.botToken) {
    bot = new Telegraf(config.telegram.botToken, {
      telegram: config.telegram.apiRoot ? { apiRoot: config.telegram.apiRoot } : {},
      handlerTimeout: 60_000,
    });
    telegram = new TelegrafGateway(bot.telegram);
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN is not set: bot, deliveries and notifications are disabled');
    telegram = new DisabledGateway();
  }

  const ctx = createContext({ config, db, logger, telegram });
  const interrupted = ctx.backups.failInterrupted();
  if (interrupted) logger.warn({ count: interrupted }, 'Marked interrupted backups as failed');

  const app = await buildApp(ctx);
  await app.listen({ host: config.host, port: config.port });

  ctx.limiter.startSweeping();
  ctx.healthMonitor.start();

  if (bot && config.telegram.botEnabled) {
    registerBot(bot, ctx);
    await configureBotProfile(bot, ctx);
    bot
      .launch({ allowedUpdates: ['message', 'my_chat_member', 'callback_query'] })
      .catch((err) => logger.error({ err }, 'Telegram bot stopped with an error'));
    logger.info('Telegram bot started (long polling)');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    try {
      bot?.stop(signal);
      ctx.healthMonitor.stop();
      ctx.limiter.stopSweeping();
      await app.close();
      await ctx.backupQueue.onIdle();
      db.$client.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
