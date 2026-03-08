import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type AppDatabase } from '../src/db/client.js';
import {
  processedMessage,
  messageReview,
  monitoredChannel,
  subscriber,
} from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

function setupTestDb(): AppDatabase {
  const db = createDb(':memory:');

  // Create tables in memory for tests
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
  db.run(sql`CREATE TABLE IF NOT EXISTS monitored_channel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    active INTEGER DEFAULT 1,
    added_at INTEGER DEFAULT (unixepoch())
  )`);
  db.run(sql`CREATE TABLE IF NOT EXISTS subscriber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1,
    subscribed_at INTEGER DEFAULT (unixepoch())
  )`);

  return db;
}

describe('Database: processed_message', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
  });

  it('inserts and retrieves a processed message', () => {
    const [inserted] = db
      .insert(processedMessage)
      .values({
        channelId: 'test_channel',
        messageId: 123,
        messageText: 'New L2 rollup announced',
        relevanceScore: 8.5,
        summary: 'New L2 launch.',
        dispatched: true,
      })
      .returning()
      .all();

    expect(inserted.id).toBeDefined();
    expect(inserted.channelId).toBe('test_channel');
    expect(inserted.messageId).toBe(123);
    expect(inserted.relevanceScore).toBe(8.5);
    expect(inserted.dispatched).toBe(true);
  });

  it('retrieves by channel and message id', () => {
    db.insert(processedMessage)
      .values({
        channelId: 'channel_a',
        messageId: 1,
        messageText: 'msg 1',
        relevanceScore: 3,
        summary: 'Low relevance.',
        dispatched: false,
      })
      .run();

    db.insert(processedMessage)
      .values({
        channelId: 'channel_a',
        messageId: 2,
        messageText: 'msg 2',
        relevanceScore: 9,
        summary: 'High relevance.',
        dispatched: true,
      })
      .run();

    const results = db
      .select()
      .from(processedMessage)
      .where(eq(processedMessage.channelId, 'channel_a'))
      .all();

    expect(results).toHaveLength(2);
  });

  it('defaults dispatched to false', () => {
    const [inserted] = db
      .insert(processedMessage)
      .values({
        channelId: 'test',
        messageId: 1,
      })
      .returning()
      .all();

    expect(inserted.dispatched).toBe(false);
  });
});

describe('Database: message_review', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
  });

  it('inserts and retrieves a review', () => {
    const [inserted] = db
      .insert(messageReview)
      .values({
        processedMessageId: 1,
        message: 'Original message text',
        botRating: 7,
        userRating: 7,
        userTgId: '12345',
        userTgName: 'Test User',
        sourceChannel: 'test_channel',
      })
      .returning()
      .all();

    expect(inserted.id).toBeDefined();
    expect(inserted.botRating).toBe(7);
    expect(inserted.userRating).toBe(7);
    expect(inserted.userTgId).toBe('12345');
  });

  it('stores different bot and user ratings', () => {
    const [inserted] = db
      .insert(messageReview)
      .values({
        message: 'Some message',
        botRating: 8,
        userRating: 3,
        userTgId: '999',
        userTgName: 'Reviewer',
      })
      .returning()
      .all();

    expect(inserted.botRating).toBe(8);
    expect(inserted.userRating).toBe(3);
  });
});

describe('Database: monitored_channel', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
  });

  it('inserts and retrieves a channel', () => {
    const [inserted] = db
      .insert(monitoredChannel)
      .values({
        channelUsername: 'blockchain_news',
        displayName: 'Blockchain News',
      })
      .returning()
      .all();

    expect(inserted.channelUsername).toBe('blockchain_news');
    expect(inserted.active).toBe(true);
  });

  it('enforces unique channel username', () => {
    db.insert(monitoredChannel)
      .values({ channelUsername: 'unique_channel' })
      .run();

    expect(() =>
      db.insert(monitoredChannel)
        .values({ channelUsername: 'unique_channel' })
        .run(),
    ).toThrow();
  });

  it('defaults active to true', () => {
    const [inserted] = db
      .insert(monitoredChannel)
      .values({ channelUsername: 'new_channel' })
      .returning()
      .all();

    expect(inserted.active).toBe(true);
  });
});

describe('Database: subscriber', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
  });

  it('inserts and retrieves a subscriber', () => {
    const [inserted] = db
      .insert(subscriber)
      .values({ chatId: '12345' })
      .returning()
      .all();

    expect(inserted.chatId).toBe('12345');
    expect(inserted.active).toBe(true);
  });

  it('enforces unique chat id', () => {
    db.insert(subscriber).values({ chatId: 'unique_chat' }).run();

    expect(() =>
      db.insert(subscriber).values({ chatId: 'unique_chat' }).run(),
    ).toThrow();
  });

  it('can deactivate a subscriber', () => {
    const [inserted] = db
      .insert(subscriber)
      .values({ chatId: 'to_deactivate' })
      .returning()
      .all();

    db.update(subscriber)
      .set({ active: false })
      .where(eq(subscriber.id, inserted.id))
      .run();

    const [updated] = db
      .select()
      .from(subscriber)
      .where(eq(subscriber.id, inserted.id))
      .all();

    expect(updated.active).toBe(false);
  });
});
