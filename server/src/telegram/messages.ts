import { escapeHtml, formatBytes, formatDuration, formatUtc, formatUtcTime } from '../lib/format.js';
import type { BackupFile, BackupMetadata, NotificationMessage } from '../services/providers.js';

const e = escapeHtml;

export function backupCaption(file: BackupFile, meta: BackupMetadata): string {
  return [
    '📦 <b>Backup</b>',
    '',
    `Service: ${e(meta.serviceName)}`,
    `File: ${e(file.filename)}`,
    `Size: ${formatBytes(file.sizeBytes)}`,
    `Backup ID: <code>${e(meta.backupId)}</code>`,
    `Created: ${formatUtc(meta.createdAt)}`,
  ].join('\n');
}

export function notificationText(message: NotificationMessage): string {
  switch (message.kind) {
    case 'service_down':
      return [
        '🚨 <b>Service Down</b>',
        '',
        `Service: ${e(message.serviceName)}`,
        `Monitor: ${e(message.monitorName)}`,
        '',
        'No heartbeat has been received within',
        'the configured timeout.',
        '',
        'Last heartbeat:',
        message.lastHeartbeatAt ? formatUtcTime(message.lastHeartbeatAt) : 'never',
      ].join('\n');
    case 'service_recovered':
      return [
        '✅ <b>Service Recovered</b>',
        '',
        `Service: ${e(message.serviceName)}`,
        `Monitor: ${e(message.monitorName)}`,
        '',
        'Heartbeat received again.',
        '',
        'Recovered:',
        formatUtcTime(message.recoveredAt),
        '',
        `Downtime: ${formatDuration(message.downtimeSeconds)}`,
      ].join('\n');
    case 'backup_failed':
      return [
        '⚠️ <b>Backup Failed</b>',
        '',
        `Service: ${e(message.serviceName)}`,
        `File: ${e(message.filename)}`,
        `Backup ID: <code>${e(message.backupId)}</code>`,
        '',
        `Reason: ${e(message.reason)}`,
      ].join('\n');
  }
}
