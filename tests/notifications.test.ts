import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type AppDatabase } from '../src/db/client.js';
import { subscriber } from '../src/db/schema.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// We need to mock grammy before importing notifications
vi.mock('grammy', () => {
  class MockInlineKeyboard {
    buttons: Array<{ text: string; data: string }> = [];
    text(text: string, data: string) {
      this.buttons.push({ text, data });
      return this;
    }
  }

  class MockBot {
    api = {
      sendMessage: vi.fn().mockResolvedValue({}),
    };
    catch() {}
    command() {}
    callbackQuery() {}
    start() {}
    stop() {}
  }

  return {
    Bot: MockBot,
    InlineKeyboard: MockInlineKeyboard,
  };
});

import {
  formatAlert,
  dispatchNotification,
  setBotInstance,
  setDbInstance,
  type NotificationPayload,
} from '../src/bot/notifications.js';
import { Bot } from 'grammy';

function setupTestDb(): AppDatabase {
  const db = createDb(':memory:');
  db.run(sql`CREATE TABLE IF NOT EXISTS subscriber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1,
    subscribed_at INTEGER DEFAULT (unixepoch())
  )`);
  return db;
}

describe('formatAlert', () => {
  it('includes score badge, summary, and source channel', () => {
    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 8,
      summary: 'New DeFi protocol launching',
      sourceChannel: 'defi_news',
      messageText: 'Check out this new DeFi thing',
    };

    const html = formatAlert(payload);

    expect(html).toContain('Score: 8/10');
    expect(html).toContain('New DeFi protocol launching');
    expect(html).toContain('defi_news');
    expect(html).toContain('New Lead Detected');
  });

  it('includes deep link when messageId is provided', () => {
    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 7,
      summary: 'Important update',
      sourceChannel: 'crypto_news',
      messageText: 'Some message text',
      messageId: 42,
    };

    const html = formatAlert(payload);

    expect(html).toContain('https://t.me/crypto_news/42');
    expect(html).toContain('View original message');
  });

  it('strips leading @ from channel username in deep link', () => {
    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 9,
      summary: 'Hot lead',
      sourceChannel: '@blockchain_daily',
      messageText: 'Breaking news',
      messageId: 100,
    };

    const html = formatAlert(payload);

    expect(html).toContain('https://t.me/blockchain_daily/100');
    expect(html).not.toContain('https://t.me/@blockchain_daily');
  });

  it('does not include deep link when messageId is not provided', () => {
    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 5,
      summary: 'Some lead',
      sourceChannel: 'news_channel',
      messageText: 'A message',
    };

    const html = formatAlert(payload);

    expect(html).not.toContain('View original message');
    expect(html).not.toContain('t.me/');
  });

  it('uses red emoji for high scores (>=8)', () => {
    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 9,
      summary: 'High score',
      sourceChannel: 'ch',
      messageText: 'msg',
    };

    const html = formatAlert(payload);
    expect(html).toContain('\uD83D\uDD34'); // red circle
  });

  it('uses yellow emoji for medium scores (6-7)', () => {
    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 6,
      summary: 'Medium score',
      sourceChannel: 'ch',
      messageText: 'msg',
    };

    const html = formatAlert(payload);
    expect(html).toContain('\uD83D\uDFE1'); // yellow circle
  });

  it('uses green emoji for low scores (<6)', () => {
    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 4,
      summary: 'Low score',
      sourceChannel: 'ch',
      messageText: 'msg',
    };

    const html = formatAlert(payload);
    expect(html).toContain('\uD83D\uDFE2'); // green circle
  });

  it('escapes HTML in message text and summary', () => {
    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 7,
      summary: 'Contains <script>alert("xss")</script>',
      sourceChannel: 'ch',
      messageText: 'Text with <b>tags</b> & "quotes"',
    };

    const html = formatAlert(payload);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;quotes&quot;');
  });

  it('truncates long message text', () => {
    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 7,
      summary: 'Summary',
      sourceChannel: 'ch',
      messageText: 'A'.repeat(300),
    };

    const html = formatAlert(payload);

    // Should be truncated with ellipsis
    expect(html).toContain('...');
  });
});

describe('dispatchNotification', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
    vi.clearAllMocks();
  });

  it('throws when bot is not initialized', async () => {
    // Reset bot instance
    setBotInstance(null as any);

    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 8,
      summary: 'Test',
      sourceChannel: 'ch',
      messageText: 'msg',
    };

    await expect(dispatchNotification(payload)).rejects.toThrow('Bot not initialized');
  });

  it('dispatches to a single chatId when provided (backward compat)', async () => {
    const bot = new Bot('test-token') as any;
    setBotInstance(bot);

    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 8,
      summary: 'Test',
      sourceChannel: 'ch',
      messageText: 'msg',
      chatId: '12345',
    };

    await dispatchNotification(payload);

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '12345',
      expect.any(String),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('dispatches to all active subscribers when no chatId', async () => {
    const bot = new Bot('test-token') as any;
    setBotInstance(bot);
    setDbInstance(db);

    // Add subscribers
    db.insert(subscriber).values({ chatId: '111', active: true }).run();
    db.insert(subscriber).values({ chatId: '222', active: true }).run();
    db.insert(subscriber).values({ chatId: '333', active: false }).run(); // inactive

    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 8,
      summary: 'Test',
      sourceChannel: 'ch',
      messageText: 'msg',
    };

    await dispatchNotification(payload);

    // Should only send to active subscribers
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.api.sendMessage).toHaveBeenCalledWith('111', expect.any(String), expect.any(Object));
    expect(bot.api.sendMessage).toHaveBeenCalledWith('222', expect.any(String), expect.any(Object));
  });

  it('warns when no active subscribers exist', async () => {
    const bot = new Bot('test-token') as any;
    setBotInstance(bot);
    setDbInstance(db);

    // No subscribers

    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 8,
      summary: 'Test',
      sourceChannel: 'ch',
      messageText: 'msg',
    };

    await dispatchNotification(payload);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('continues dispatching if one subscriber fails', async () => {
    const bot = new Bot('test-token') as any;
    setBotInstance(bot);
    setDbInstance(db);

    db.insert(subscriber).values({ chatId: '111', active: true }).run();
    db.insert(subscriber).values({ chatId: '222', active: true }).run();

    // First call fails, second succeeds
    bot.api.sendMessage
      .mockRejectedValueOnce(new Error('Chat not found'))
      .mockResolvedValueOnce({});

    const payload: NotificationPayload = {
      processedMessageId: 1,
      score: 8,
      summary: 'Test',
      sourceChannel: 'ch',
      messageText: 'msg',
    };

    await dispatchNotification(payload);

    // Both should have been attempted
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });
});
