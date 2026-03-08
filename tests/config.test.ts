import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
    // Clear module cache so config re-reads env
    vi.resetModules();
  });

  it('reads RELEVANCE_THRESHOLD from env with default 5', async () => {
    delete process.env.RELEVANCE_THRESHOLD;
    const { config } = await import('../src/config.js');
    expect(config.relevanceThreshold).toBe(5);
  });

  it('reads custom RELEVANCE_THRESHOLD from env', async () => {
    process.env.RELEVANCE_THRESHOLD = '7';
    const { config } = await import('../src/config.js');
    expect(config.relevanceThreshold).toBe(7);
  });

  it('reads LLM_MODEL from env with default', async () => {
    delete process.env.LLM_MODEL;
    const { config } = await import('../src/config.js');
    expect(config.llmModel).toBe('claude-sonnet-4-20250514');
  });

  it('reads custom LLM_MODEL from env', async () => {
    process.env.LLM_MODEL = 'claude-haiku-3';
    const { config } = await import('../src/config.js');
    expect(config.llmModel).toBe('claude-haiku-3');
  });

  it('parses ADMIN_IDS as comma-separated list', async () => {
    process.env.ADMIN_IDS = '111,222,333';
    delete process.env.ADMIN_CHAT_ID;
    const { config } = await import('../src/config.js');
    expect(config.adminIds).toEqual(['111', '222', '333']);
  });

  it('trims whitespace from ADMIN_IDS entries', async () => {
    process.env.ADMIN_IDS = ' 111 , 222 , 333 ';
    delete process.env.ADMIN_CHAT_ID;
    const { config } = await import('../src/config.js');
    expect(config.adminIds).toEqual(['111', '222', '333']);
  });

  it('falls back to ADMIN_CHAT_ID when ADMIN_IDS not set', async () => {
    delete process.env.ADMIN_IDS;
    process.env.ADMIN_CHAT_ID = '99999';
    const { config } = await import('../src/config.js');
    expect(config.adminIds).toEqual(['99999']);
  });

  it('returns empty adminIds when neither ADMIN_IDS nor ADMIN_CHAT_ID is set', async () => {
    delete process.env.ADMIN_IDS;
    delete process.env.ADMIN_CHAT_ID;
    const { config } = await import('../src/config.js');
    expect(config.adminIds).toEqual([]);
  });
});

describe('prompt loading', () => {
  it('loads system prompt from prompts/system.txt', async () => {
    // Reset cached prompt by re-importing the module
    vi.resetModules();
    const { getSystemPrompt } = await import('../src/analysis/prompt.js');
    const prompt = getSystemPrompt();

    expect(prompt).toBeTruthy();
    expect(prompt).toContain('sqd.ai');
    expect(prompt).toContain('blockchain');
  });
});
