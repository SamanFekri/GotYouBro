import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Destination } from '../database/schema.js';
import type { BackupDestinationProvider, BackupFile, BackupMetadata } from '../services/providers.js';
import { TelegramApiError, type TelegramGateway } from './gateway.js';
import { backupCaption } from './messages.js';

const MAX_ATTEMPTS = 3;

export class TelegramBackupDestination implements BackupDestinationProvider {
  constructor(
    private readonly telegram: TelegramGateway,
    private readonly logger: Logger,
    private readonly retryDelayMs = 2000,
  ) {}

  async deliver(destination: Destination, file: BackupFile, metadata: BackupMetadata) {
    let chatId = destination.telegramChatId;
    for (let attempt = 1; ; attempt++) {
      try {
        const { messageId } = await this.telegram.sendDocument(
          chatId,
          { path: file.path, filename: file.filename },
          { threadId: destination.telegramThreadId, caption: backupCaption(file, metadata), html: true },
        );
        return { externalId: String(messageId) };
      } catch (err) {
        // The group was upgraded to a supergroup: send to its new id (the bot updates the record).
        if (err instanceof TelegramApiError && err.migrateToChatId && chatId !== err.migrateToChatId) {
          chatId = err.migrateToChatId;
          continue;
        }
        const retryable = err instanceof TelegramApiError && err.retryable;
        if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
        const waitMs = err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : this.retryDelayMs * attempt;
        this.logger.warn({ backupId: metadata.backupId, attempt, waitMs, err: err.message }, 'Telegram delivery failed, retrying');
        await sleep(waitMs);
      }
    }
  }
}
