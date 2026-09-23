import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';

const MB = 1024 * 1024;

describe('config', () => {
  it('defaults to port 6969 and a 1.5 GB max backup size', () => {
    const config = loadConfig({});
    expect(config.port).toBe(6969);
    expect(config.defaults.maxBackupSizeMb).toBe(1536);
  });

  it('caps Telegram uploads at 50 MB on the official Bot API', () => {
    expect(loadConfig({}).telegram.maxFileBytes).toBe(50 * MB);
  });

  it('raises the Telegram cap to 2000 MB with a local Bot API server', () => {
    expect(loadConfig({ TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081' }).telegram.maxFileBytes).toBe(2000 * MB);
  });

  it('respects an explicit TELEGRAM_MAX_FILE_MB', () => {
    expect(loadConfig({ TELEGRAM_API_ROOT: 'http://x:8081', TELEGRAM_MAX_FILE_MB: '1500' }).telegram.maxFileBytes).toBe(1500 * MB);
  });
});
