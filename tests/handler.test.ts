import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type AppDatabase } from '../src/db/client.js';
import { processedMessage } from '../src/db/schema.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock scorer
vi.mock('../src/analysis/scorer.js', () => ({
  scoreMessage: vi.fn().mockResolvedValue({
    relevance_score: 7,
    summary: 'Test summary',
    is_relevant: true,
  }),
}));

// Mock link-fetcher
vi.mock('../src/analysis/link-fetcher.js', () => ({
  extractUrls: vi.fn().mockReturnValue([]),
  fetchLinks: vi.fn().mockResolvedValue([]),
}));

// Mock notifications
vi.mock('../src/bot/notifications.js', () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
}));

// Mock telegram events
vi.mock('telegram/events/index.js', () => ({
  NewMessage: vi.fn(),
}));

// Mock telegram
vi.mock('telegram', () => ({
  TelegramClient: vi.fn(),
}));

import { handleNewMessage } from '../src/monitor/handler.js';
import { logger } from '../src/utils/logger.js';
import { scoreMessage } from '../src/analysis/scorer.js';

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
  return db;
}

function createMockEvent(overrides: Record<string, any> = {}) {
  return {
    message: {
      id: 1,
      text: '',
      message: '',
      entities: [],
      ...overrides,
    },
  } as any;
}

describe('handleNewMessage', () => {
  let db: AppDatabase;
  let sendNotification: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = setupTestDb();
    sendNotification = vi.fn().mockResolvedValue(undefined);
    vi.clearAllMocks();
    // Reset default scorer behavior
    vi.mocked(scoreMessage).mockResolvedValue({
      relevance_score: 7,
      summary: 'Test summary',
      is_relevant: true,
    });
  });

  describe('media messages with captions', () => {
    it('processes a media message with caption text', async () => {
      const event = createMockEvent({
        text: 'Check out this new DeFi launch!',
        message: 'Check out this new DeFi launch!',
        media: { className: 'MessageMediaPhoto' },
      });

      await handleNewMessage(event, {
        db,
        channel: 'test_channel',
        threshold: 5,
        sendNotification,
      });

      // Should have scored the message
      expect(scoreMessage).toHaveBeenCalledWith(
        'Check out this new DeFi launch!',
        [],
      );

      // Should have persisted to DB
      const messages = db.select().from(processedMessage).all();
      expect(messages).toHaveLength(1);
      expect(messages[0].messageText).toBe('Check out this new DeFi launch!');
    });

    it('uses message property as fallback when text is empty (caption extraction)', async () => {
      // GramJS sometimes has the caption in .message but .text is empty
      const event = createMockEvent({
        text: '',
        message: 'Caption from media message',
        media: { className: 'MessageMediaDocument' },
      });

      await handleNewMessage(event, {
        db,
        channel: 'test_channel',
        threshold: 5,
        sendNotification,
      });

      expect(scoreMessage).toHaveBeenCalledWith(
        'Caption from media message',
        [],
      );
    });
  });

  describe('forwarded messages', () => {
    it('processes forwarded messages and logs forwarded status', async () => {
      const event = createMockEvent({
        text: 'Forwarded blockchain news',
        message: 'Forwarded blockchain news',
        fwdFrom: { fromId: 12345, date: 1700000000 },
      });

      await handleNewMessage(event, {
        db,
        channel: 'test_channel',
        threshold: 5,
        sendNotification,
      });

      // Should log that it's a forwarded message
      expect(logger.info).toHaveBeenCalledWith(
        'Processing forwarded message',
        expect.objectContaining({
          forwarded: true,
          channel: 'test_channel',
        }),
      );

      // Should process the message text normally
      expect(scoreMessage).toHaveBeenCalledWith(
        'Forwarded blockchain news',
        [],
      );
    });

    it('includes forwarded flag in the processing log', async () => {
      const event = createMockEvent({
        text: 'Forwarded content',
        message: 'Forwarded content',
        fwdFrom: { fromId: 99999 },
      });

      await handleNewMessage(event, {
        db,
        channel: 'test_channel',
        threshold: 5,
        sendNotification,
      });

      expect(logger.info).toHaveBeenCalledWith(
        'Processing message',
        expect.objectContaining({
          isForwarded: true,
        }),
      );
    });
  });

  describe('zero text content', () => {
    it('skips messages with no text (media only, no caption)', async () => {
      const event = createMockEvent({
        text: '',
        message: '',
        media: { className: 'MessageMediaPhoto' },
      });

      await handleNewMessage(event, {
        db,
        channel: 'test_channel',
        threshold: 5,
        sendNotification,
      });

      // Should log the skip
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping message with no text content',
        expect.objectContaining({
          messageId: 1,
          channel: 'test_channel',
          hasMedia: true,
        }),
      );

      // Should NOT have scored or persisted
      expect(scoreMessage).not.toHaveBeenCalled();
      const messages = db.select().from(processedMessage).all();
      expect(messages).toHaveLength(0);
    });

    it('skips messages with undefined text', async () => {
      const event = createMockEvent({
        text: undefined,
        message: undefined,
      });

      await handleNewMessage(event, {
        db,
        channel: 'test_channel',
        threshold: 5,
        sendNotification,
      });

      expect(logger.info).toHaveBeenCalledWith(
        'Skipping message with no text content',
        expect.any(Object),
      );
      expect(scoreMessage).not.toHaveBeenCalled();
    });

    it('skips messages with whitespace-only text', async () => {
      const event = createMockEvent({
        text: '   \n\t  ',
        message: '   \n\t  ',
      });

      await handleNewMessage(event, {
        db,
        channel: 'test_channel',
        threshold: 5,
        sendNotification,
      });

      expect(logger.info).toHaveBeenCalledWith(
        'Skipping message with no text content',
        expect.any(Object),
      );
      expect(scoreMessage).not.toHaveBeenCalled();
    });
  });

  describe('dispatch decision', () => {
    it('dispatches notification when score exceeds threshold', async () => {
      vi.mocked(scoreMessage).mockResolvedValue({
        relevance_score: 8,
        summary: 'High relevance',
        is_relevant: true,
      });

      const event = createMockEvent({
        text: 'Important blockchain news',
        message: 'Important blockchain news',
      });

      await handleNewMessage(event, {
        db,
        channel: 'test_channel',
        threshold: 5,
        sendNotification,
      });

      expect(sendNotification).toHaveBeenCalled();
    });

    it('does not dispatch notification when score is below threshold', async () => {
      vi.mocked(scoreMessage).mockResolvedValue({
        relevance_score: 3,
        summary: 'Low relevance',
        is_relevant: false,
      });

      const event = createMockEvent({
        text: 'Weather report today',
        message: 'Weather report today',
      });

      await handleNewMessage(event, {
        db,
        channel: 'test_channel',
        threshold: 5,
        sendNotification,
      });

      expect(sendNotification).not.toHaveBeenCalled();
    });
  });
});
