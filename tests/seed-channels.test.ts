import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type AppDatabase } from '../src/db/client.js';
import { monitoredChannel } from '../src/db/schema.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { seedChannels, getActiveChannels, type ChannelConfig } from '../src/db/seed-channels.js';

function setupTestDb(): AppDatabase {
  const db = createDb(':memory:');
  db.run(sql`CREATE TABLE IF NOT EXISTS monitored_channel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    active INTEGER DEFAULT 1,
    added_at INTEGER DEFAULT (unixepoch())
  )`);
  return db;
}

describe('seedChannels', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
    vi.clearAllMocks();
  });

  it('seeds channels from config into an empty table', () => {
    const channels: ChannelConfig[] = [
      { username: 'channel_a', displayName: 'Channel A' },
      { username: 'channel_b', displayName: 'Channel B' },
    ];

    seedChannels(db, channels);

    const rows = db.select().from(monitoredChannel).all();
    expect(rows).toHaveLength(2);
    expect(rows[0].channelUsername).toBe('channel_a');
    expect(rows[0].displayName).toBe('Channel A');
    expect(rows[1].channelUsername).toBe('channel_b');
  });

  it('does not duplicate existing channels (upsert behavior)', () => {
    // Pre-insert one channel
    db.insert(monitoredChannel)
      .values({ channelUsername: 'channel_a', displayName: 'Old Name' })
      .run();

    const channels: ChannelConfig[] = [
      { username: 'channel_a', displayName: 'New Name' },
      { username: 'channel_b' },
    ];

    seedChannels(db, channels);

    const rows = db.select().from(monitoredChannel).all();
    expect(rows).toHaveLength(2);

    // Existing channel should keep its old display name (no update)
    const chA = rows.find((r) => r.channelUsername === 'channel_a');
    expect(chA?.displayName).toBe('Old Name');
  });

  it('handles empty channel list', () => {
    seedChannels(db, []);

    const rows = db.select().from(monitoredChannel).all();
    expect(rows).toHaveLength(0);
  });

  it('handles channel without displayName', () => {
    const channels: ChannelConfig[] = [{ username: 'no_display_name' }];

    seedChannels(db, channels);

    const rows = db.select().from(monitoredChannel).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBeNull();
  });
});

describe('getActiveChannels', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = setupTestDb();
  });

  it('returns only active channels', () => {
    db.insert(monitoredChannel)
      .values({ channelUsername: 'active_ch', active: true })
      .run();
    db.insert(monitoredChannel)
      .values({ channelUsername: 'inactive_ch', active: false })
      .run();

    const active = getActiveChannels(db);
    expect(active).toHaveLength(1);
    expect(active[0].channelUsername).toBe('active_ch');
  });

  it('returns empty array when no active channels', () => {
    db.insert(monitoredChannel)
      .values({ channelUsername: 'inactive_ch', active: false })
      .run();

    const active = getActiveChannels(db);
    expect(active).toHaveLength(0);
  });
});
