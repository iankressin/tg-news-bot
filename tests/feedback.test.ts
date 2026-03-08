import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { createDb, type AppDatabase } from '../src/db/client.js';
import { processedMessage, messageReview, subscriber } from '../src/db/schema.js';

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
    buttons: Array<Array<{ text: string; data: string }>> = [[]];
    text(text: string, data: string) {
      this.buttons[this.buttons.length - 1].push({ text, data });
      return this;
    }
    row() {
      this.buttons.push([]);
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

import { createBot } from '../src/bot/bot.js';

function setupTestDb(): AppDatabase {
  const db = createDb(':memory:');
  db.run(sql`CREATE TABLE IF NOT EXISTS processed_message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    message_text TEXT,
    relevance_score REAL,
    summary TEXT,
    dispatched INTEGER DEFAULT 0,
    processed_at INTEGER DEFAULT (unixepoch())
  )`);
  db.run(sql`CREATE TABLE IF NOT EXISTS message_review (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    processed_message_id INTEGER,
    message TEXT NOT NULL,
    bot_rating REAL NOT NULL,
    user_rating REAL NOT NULL,
    user_tg_id TEXT NOT NULL,
    user_tg_name TEXT NOT NULL,
    source_channel TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  )`);
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
    callbackQuery: { data: '' },
    reply: vi.fn().mockResolvedValue({}),
    editMessageText: vi.fn().mockResolvedValue({}),
    editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
    answerCallbackQuery: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function insertProcessedMessage(db: AppDatabase, overrides: Record<string, any> = {}) {
  const [inserted] = db
    .insert(processedMessage)
    .values({
      channelId: 'test_channel',
      messageId: 100,
      messageText: 'New blockchain protocol announced',
      relevanceScore: 7.5,
      summary: 'Relevant blockchain news',
      dispatched: true,
      ...overrides,
    })
    .returning()
    .all();
  return inserted;
}

function findCallbackHandler(bot: any, callbackData: string) {
  return bot.callbackHandlers.find(
    (h: any) => h.pattern.test(callbackData),
  );
}

describe('Feedback: Accurate rating', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
    vi.clearAllMocks();
  });

  it('saves review with userRating = botRating and edits message', async () => {
    const msg = insertProcessedMessage(db);
    const bot = createBot({ token: 'test-token', db, adminIds: ['99999'] }) as any;

    const handler = findCallbackHandler(bot, `accurate:${msg.id}`);
    expect(handler).toBeDefined();

    const ctx = createMockContext({
      match: [`accurate:${msg.id}`, String(msg.id)],
      from: { id: 12345, first_name: 'Test', last_name: 'User' },
    });

    await handler!.handler(ctx);

    // Check review was saved
    const reviews = db.select().from(messageReview).all();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].processedMessageId).toBe(msg.id);
    expect(reviews[0].botRating).toBe(7.5);
    expect(reviews[0].userRating).toBe(7.5);
    expect(reviews[0].userTgId).toBe('12345');
    expect(reviews[0].userTgName).toBe('Test User');
    expect(reviews[0].message).toBe('New blockchain protocol announced');
    expect(reviews[0].sourceChannel).toBe('test_channel');

    // Keyboard removed but message text preserved
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: undefined });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Thanks! Rating confirmed.' });
  });

  it('does not create duplicate review for same user and message', async () => {
    const msg = insertProcessedMessage(db);
    const bot = createBot({ token: 'test-token', db, adminIds: ['99999'] }) as any;

    // Insert an existing review
    db.insert(messageReview)
      .values({
        processedMessageId: msg.id,
        message: msg.messageText || '',
        botRating: 7.5,
        userRating: 7.5,
        userTgId: '12345',
        userTgName: 'Test User',
        sourceChannel: 'test_channel',
      })
      .run();

    const handler = findCallbackHandler(bot, `accurate:${msg.id}`);

    const ctx = createMockContext({
      match: [`accurate:${msg.id}`, String(msg.id)],
      from: { id: 12345, first_name: 'Test', last_name: 'User' },
    });

    await handler!.handler(ctx);

    // Should still have only 1 review
    const reviews = db.select().from(messageReview).all();
    expect(reviews).toHaveLength(1);

    // Should answer with duplicate message
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'You have already rated this message.',
    });
  });

  it('handles missing processedMessage gracefully', async () => {
    const bot = createBot({ token: 'test-token', db, adminIds: ['99999'] }) as any;

    const handler = findCallbackHandler(bot, 'accurate:999');

    const ctx = createMockContext({
      match: ['accurate:999', '999'],
      from: { id: 12345, first_name: 'Test' },
    });

    await handler!.handler(ctx);

    // No review should be created
    const reviews = db.select().from(messageReview).all();
    expect(reviews).toHaveLength(0);

    // Should answer with error message
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'This message is no longer available.',
    });
  });
});

describe('Feedback: Inaccurate rating', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
    vi.clearAllMocks();
  });

  it('replaces keyboard with score buttons (0-5, 6-10)', async () => {
    const msg = insertProcessedMessage(db);
    const bot = createBot({ token: 'test-token', db, adminIds: ['99999'] }) as any;

    const handler = findCallbackHandler(bot, `inaccurate:${msg.id}`);
    expect(handler).toBeDefined();

    const ctx = createMockContext({
      match: [`inaccurate:${msg.id}`, String(msg.id)],
      from: { id: 12345, first_name: 'Test' },
    });

    await handler!.handler(ctx);

    // Should have edited the reply markup with score buttons
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
      reply_markup: expect.objectContaining({
        buttons: expect.any(Array),
      }),
    });

    // Verify the keyboard has correct score buttons
    const keyboard = ctx.editMessageReplyMarkup.mock.calls[0][0].reply_markup;
    // First row: 0-5
    expect(keyboard.buttons[0]).toHaveLength(6);
    expect(keyboard.buttons[0][0].data).toBe(`score:${msg.id}:0`);
    expect(keyboard.buttons[0][5].data).toBe(`score:${msg.id}:5`);
    // Second row: 6-10
    expect(keyboard.buttons[1]).toHaveLength(5);
    expect(keyboard.buttons[1][0].data).toBe(`score:${msg.id}:6`);
    expect(keyboard.buttons[1][4].data).toBe(`score:${msg.id}:10`);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('handles missing processedMessage gracefully', async () => {
    const bot = createBot({ token: 'test-token', db, adminIds: ['99999'] }) as any;

    const handler = findCallbackHandler(bot, 'inaccurate:999');

    const ctx = createMockContext({
      match: ['inaccurate:999', '999'],
      from: { id: 12345 },
    });

    await handler!.handler(ctx);

    // Should not attempt to edit markup
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();

    // Should answer with error
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'This message is no longer available.',
    });
  });
});

describe('Feedback: Score selection', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
    vi.clearAllMocks();
  });

  it('saves review with user-selected score and edits message', async () => {
    const msg = insertProcessedMessage(db);
    const bot = createBot({ token: 'test-token', db, adminIds: ['99999'] }) as any;

    const handler = findCallbackHandler(bot, `score:${msg.id}:3`);
    expect(handler).toBeDefined();

    const ctx = createMockContext({
      match: [`score:${msg.id}:3`, String(msg.id), '3'],
      from: { id: 12345, first_name: 'Test', last_name: 'User' },
    });

    await handler!.handler(ctx);

    // Check review was saved with user's score
    const reviews = db.select().from(messageReview).all();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].processedMessageId).toBe(msg.id);
    expect(reviews[0].botRating).toBe(7.5);
    expect(reviews[0].userRating).toBe(3);
    expect(reviews[0].userTgId).toBe('12345');
    expect(reviews[0].userTgName).toBe('Test User');
    expect(reviews[0].sourceChannel).toBe('test_channel');

    // Keyboard removed but message text preserved
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: undefined });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Thanks! Your rating: 3/10' });
  });

  it('does not create duplicate review for same user and message', async () => {
    const msg = insertProcessedMessage(db);
    const bot = createBot({ token: 'test-token', db, adminIds: ['99999'] }) as any;

    // Insert an existing review
    db.insert(messageReview)
      .values({
        processedMessageId: msg.id,
        message: msg.messageText || '',
        botRating: 7.5,
        userRating: 5,
        userTgId: '12345',
        userTgName: 'Test User',
        sourceChannel: 'test_channel',
      })
      .run();

    const handler = findCallbackHandler(bot, `score:${msg.id}:8`);

    const ctx = createMockContext({
      match: [`score:${msg.id}:8`, String(msg.id), '8'],
      from: { id: 12345, first_name: 'Test', last_name: 'User' },
    });

    await handler!.handler(ctx);

    // Should still have only 1 review
    const reviews = db.select().from(messageReview).all();
    expect(reviews).toHaveLength(1);
    // Original rating should be preserved
    expect(reviews[0].userRating).toBe(5);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'You have already rated this message.',
    });
  });

  it('handles missing processedMessage gracefully', async () => {
    const bot = createBot({ token: 'test-token', db, adminIds: ['99999'] }) as any;

    const handler = findCallbackHandler(bot, 'score:999:5');

    const ctx = createMockContext({
      match: ['score:999:5', '999', '5'],
      from: { id: 12345 },
    });

    await handler!.handler(ctx);

    // No review should be created
    const reviews = db.select().from(messageReview).all();
    expect(reviews).toHaveLength(0);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'This message is no longer available.',
    });
  });

  it('allows different users to rate the same message', async () => {
    const msg = insertProcessedMessage(db);
    const bot = createBot({ token: 'test-token', db, adminIds: ['99999'] }) as any;

    // First user rates via accurate
    const accurateHandler = findCallbackHandler(bot, `accurate:${msg.id}`);
    const ctx1 = createMockContext({
      match: [`accurate:${msg.id}`, String(msg.id)],
      from: { id: 11111, first_name: 'Alice' },
    });
    await accurateHandler!.handler(ctx1);

    // Second user rates via score selection
    const scoreHandler = findCallbackHandler(bot, `score:${msg.id}:4`);
    const ctx2 = createMockContext({
      match: [`score:${msg.id}:4`, String(msg.id), '4'],
      from: { id: 22222, first_name: 'Bob' },
    });
    await scoreHandler!.handler(ctx2);

    // Both reviews should exist
    const reviews = db.select().from(messageReview).all();
    expect(reviews).toHaveLength(2);

    const aliceReview = reviews.find((r) => r.userTgId === '11111');
    const bobReview = reviews.find((r) => r.userTgId === '22222');

    expect(aliceReview?.userRating).toBe(7.5); // same as bot
    expect(bobReview?.userRating).toBe(4); // user-selected
  });
});
