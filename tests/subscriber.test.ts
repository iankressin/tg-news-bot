import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
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

// Mock grammy
vi.mock('grammy', () => {
  class MockInlineKeyboard {
    buttons: Array<{ text: string; data: string }> = [];
    text(text: string, data: string) {
      this.buttons.push({ text, data });
      return this;
    }
  }

  class MockBot {
    handlers: Record<string, Function> = {};
    callbackHandlers: Array<{ pattern: RegExp; handler: Function }> = [];
    errorHandler: Function | null = null;
    api = {
      sendMessage: vi.fn().mockResolvedValue({}),
      setMyCommands: vi.fn().mockResolvedValue(true),
    };

    constructor(_token: string) {}

    catch(handler: Function) {
      this.errorHandler = handler;
    }

    command(name: string, handler: Function) {
      this.handlers[name] = handler;
    }

    callbackQuery(pattern: RegExp | string, handler: Function) {
      if (typeof pattern === 'string') {
        this.callbackHandlers.push({
          pattern: new RegExp(`^${pattern.replace('*', '.*')}$`),
          handler,
        });
      } else {
        this.callbackHandlers.push({ pattern, handler });
      }
    }

    start() {}
    stop() {}
  }

  return {
    Bot: MockBot,
    InlineKeyboard: MockInlineKeyboard,
  };
});

import { createBot, type CreateBotOptions } from '../src/bot/bot.js';

function setupTestDb(): AppDatabase {
  const db = createDb(':memory:');
  db.run(sql`CREATE TABLE IF NOT EXISTS subscriber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1,
    subscribed_at INTEGER DEFAULT (unixepoch())
  )`);
  db.run(sql`CREATE TABLE IF NOT EXISTS monitored_channel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    active INTEGER DEFAULT 1,
    added_at INTEGER DEFAULT (unixepoch())
  )`);
  return db;
}

function createMockContext(overrides: Record<string, any> = {}) {
  return {
    from: { id: 12345, username: 'testuser', first_name: 'Test', last_name: 'User' },
    chat: { id: 12345 },
    reply: vi.fn().mockResolvedValue({}),
    editMessageText: vi.fn().mockResolvedValue({}),
    answerCallbackQuery: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('Subscriber onboarding via /start', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
    vi.clearAllMocks();
  });

  it('auto-subscribes admin users', async () => {
    const adminIds = ['12345'];
    const bot = createBot({ token: 'test-token', db, adminIds }) as any;

    const ctx = createMockContext({
      from: { id: 12345, username: 'admin' },
      chat: { id: 12345 },
    });

    // Invoke the /start handler
    await bot.handlers['start'](ctx);

    // Check DB
    const subs = db.select().from(subscriber).all();
    expect(subs).toHaveLength(1);
    expect(subs[0].chatId).toBe('12345');
    expect(subs[0].active).toBe(true);

    // Check reply
    expect(ctx.reply).toHaveBeenCalledWith(
      'Welcome, admin! You have been subscribed to lead alerts.',
    );
  });

  it('re-activates an existing inactive admin subscriber', async () => {
    const adminIds = ['12345'];

    // Pre-insert as inactive
    db.insert(subscriber).values({ chatId: '12345', active: false }).run();

    const bot = createBot({ token: 'test-token', db, adminIds }) as any;

    const ctx = createMockContext({
      from: { id: 12345 },
      chat: { id: 12345 },
    });

    await bot.handlers['start'](ctx);

    const subs = db.select().from(subscriber).all();
    expect(subs).toHaveLength(1);
    expect(subs[0].active).toBe(true);
  });

  it('sends approval request to admin subscribers for non-admin users', async () => {
    const adminIds = ['99999'];

    // Admin is already subscribed
    db.insert(subscriber).values({ chatId: '99999', active: true }).run();

    const bot = createBot({ token: 'test-token', db, adminIds }) as any;

    const ctx = createMockContext({
      from: { id: 55555, username: 'newuser', first_name: 'New', last_name: 'User' },
      chat: { id: 55555 },
    });

    await bot.handlers['start'](ctx);

    // Should send approval request to admin
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '99999',
      expect.stringContaining('New subscription request'),
      expect.objectContaining({
        parse_mode: 'HTML',
        reply_markup: expect.anything(),
      }),
    );

    // Should reply to user
    expect(ctx.reply).toHaveBeenCalledWith(
      'Your subscription request has been submitted. An admin will review it shortly.',
    );
  });

  it('sends approval request to multiple admin subscribers', async () => {
    const adminIds = ['11111', '22222'];

    db.insert(subscriber).values({ chatId: '11111', active: true }).run();
    db.insert(subscriber).values({ chatId: '22222', active: true }).run();

    const bot = createBot({ token: 'test-token', db, adminIds }) as any;

    const ctx = createMockContext({
      from: { id: 33333, username: 'wannasub' },
      chat: { id: 33333 },
    });

    await bot.handlers['start'](ctx);

    // Should send to both admins
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.api.sendMessage).toHaveBeenCalledWith('11111', expect.any(String), expect.any(Object));
    expect(bot.api.sendMessage).toHaveBeenCalledWith('22222', expect.any(String), expect.any(Object));
  });

  it('handles non-admin /start when no admin subscribers exist', async () => {
    const adminIds = ['99999']; // admin exists but not subscribed

    const bot = createBot({ token: 'test-token', db, adminIds }) as any;

    const ctx = createMockContext({
      from: { id: 55555 },
      chat: { id: 55555 },
    });

    await bot.handlers['start'](ctx);

    // Should still reply to the user
    expect(ctx.reply).toHaveBeenCalledWith(
      'Your subscription request has been submitted. An admin will review it shortly.',
    );

    // Should not have sent any approval messages
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('Approval callback handlers', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
    vi.clearAllMocks();
  });

  it('approves a subscriber and notifies them', async () => {
    const adminIds = ['99999'];
    const bot = createBot({ token: 'test-token', db, adminIds }) as any;

    // Find the approve handler
    const approveHandler = bot.callbackHandlers.find(
      (h: any) => h.pattern.test('approve:55555:55555'),
    );
    expect(approveHandler).toBeDefined();

    const ctx = createMockContext({
      match: ['approve:55555:55555', '55555', '55555'],
      from: { id: 99999 },
    });

    await approveHandler!.handler(ctx);

    // Check subscriber was added
    const subs = db.select().from(subscriber).all();
    expect(subs).toHaveLength(1);
    expect(subs[0].chatId).toBe('55555');
    expect(subs[0].active).toBe(true);

    // Check user was notified
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '55555',
      'Your subscription has been approved! You will now receive lead alerts.',
    );

    // Check admin message was edited
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Approved subscription for user 55555'),
    );
  });

  it('re-activates an existing inactive subscriber on approve', async () => {
    const adminIds = ['99999'];

    // Pre-insert as inactive
    db.insert(subscriber).values({ chatId: '55555', active: false }).run();

    const bot = createBot({ token: 'test-token', db, adminIds }) as any;

    const approveHandler = bot.callbackHandlers.find(
      (h: any) => h.pattern.test('approve:55555:55555'),
    );

    const ctx = createMockContext({
      match: ['approve:55555:55555', '55555', '55555'],
      from: { id: 99999 },
    });

    await approveHandler!.handler(ctx);

    const subs = db.select().from(subscriber).all();
    expect(subs).toHaveLength(1);
    expect(subs[0].active).toBe(true);
  });

  it('denies a subscriber and notifies them', async () => {
    const adminIds = ['99999'];
    const bot = createBot({ token: 'test-token', db, adminIds }) as any;

    const denyHandler = bot.callbackHandlers.find(
      (h: any) => h.pattern.test('deny:55555:55555'),
    );
    expect(denyHandler).toBeDefined();

    const ctx = createMockContext({
      match: ['deny:55555:55555', '55555', '55555'],
      from: { id: 99999 },
    });

    await denyHandler!.handler(ctx);

    // Check user was notified of denial
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '55555',
      'Your subscription request has been denied by an admin.',
    );

    // Check admin message was edited
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Denied subscription for user 55555'),
    );

    // No subscriber should be added
    const subs = db.select().from(subscriber).all();
    expect(subs).toHaveLength(0);
  });
});
