import type { Logger } from 'pino';
import type { NotificationMessage, NotificationProvider, NotificationTarget } from '../services/providers.js';
import type { TelegramGateway } from './gateway.js';
import { notificationText } from './messages.js';

export class TelegramNotificationProvider implements NotificationProvider {
  constructor(
    private readonly telegram: TelegramGateway,
    private readonly logger: Logger,
  ) {}

  async notify(target: NotificationTarget, message: NotificationMessage): Promise<boolean> {
    try {
      await this.telegram.sendMessage(target.telegramId, notificationText(message), { html: true });
      return true;
    } catch (err) {
      this.logger.warn({ kind: message.kind, err: (err as Error).message }, 'Failed to send Telegram notification');
      return false;
    }
  }
}
