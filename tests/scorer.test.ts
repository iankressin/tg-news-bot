import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalysisSchema } from '../src/analysis/scorer.js';

// Mock the prompt module
vi.mock('../src/analysis/prompt.js', () => ({
  getSystemPrompt: () => 'You are a test prompt.',
}));

// Mock the Vercel AI SDK
vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn(() => 'mocked-model'),
}));

import { scoreMessage, buildPrompt } from '../src/analysis/scorer.js';
import { generateObject } from 'ai';

const mockGenerateObject = vi.mocked(generateObject);

describe('AnalysisSchema', () => {
  it('accepts a valid analysis result', () => {
    const valid = {
      relevance_score: 7,
      summary: 'New L2 rollup launching with data infrastructure needs.',
      is_relevant: true,
    };
    expect(AnalysisSchema.parse(valid)).toEqual(valid);
  });

  it('rejects score below 0', () => {
    const invalid = {
      relevance_score: -1,
      summary: 'Test',
      is_relevant: false,
    };
    expect(() => AnalysisSchema.parse(invalid)).toThrow();
  });

  it('rejects score above 10', () => {
    const invalid = {
      relevance_score: 11,
      summary: 'Test',
      is_relevant: true,
    };
    expect(() => AnalysisSchema.parse(invalid)).toThrow();
  });

  it('rejects missing summary', () => {
    const invalid = {
      relevance_score: 5,
      is_relevant: false,
    };
    expect(() => AnalysisSchema.parse(invalid)).toThrow();
  });

  it('rejects missing is_relevant', () => {
    const invalid = {
      relevance_score: 5,
      summary: 'Test',
    };
    expect(() => AnalysisSchema.parse(invalid)).toThrow();
  });
});

describe('buildPrompt', () => {
  it('builds prompt with message text only', () => {
    const prompt = buildPrompt('Hello world');
    expect(prompt).toBe('Message:\nHello world');
  });

  it('includes link content when provided', () => {
    const prompt = buildPrompt('Check this link', [
      { url: 'https://example.com', content: 'Article about blockchain' },
    ]);
    expect(prompt).toContain('Message:\nCheck this link');
    expect(prompt).toContain('Linked content from https://example.com:');
    expect(prompt).toContain('Article about blockchain');
  });

  it('includes multiple link contents', () => {
    const prompt = buildPrompt('Two links', [
      { url: 'https://a.com', content: 'Content A' },
      { url: 'https://b.com', content: 'Content B' },
    ]);
    expect(prompt).toContain('Linked content from https://a.com:');
    expect(prompt).toContain('Content A');
    expect(prompt).toContain('Linked content from https://b.com:');
    expect(prompt).toContain('Content B');
  });

  it('handles empty link contents array', () => {
    const prompt = buildPrompt('No links', []);
    expect(prompt).toBe('Message:\nNo links');
  });
});

describe('scoreMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns structured analysis result from LLM', async () => {
    const expectedResult = {
      relevance_score: 8,
      summary: 'New DeFi protocol launching on Arbitrum.',
      is_relevant: true,
    };

    mockGenerateObject.mockResolvedValue({
      object: expectedResult,
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 50 },
      warnings: undefined,
      request: {} as any,
      response: {
        id: 'test',
        timestamp: new Date(),
        modelId: 'test',
        headers: undefined,
        body: undefined,
      },
      toJsonResponse: () => new Response(),
      rawResponse: undefined,
      logprobs: undefined,
      providerMetadata: undefined,
      experimental_providerMetadata: undefined,
    } as any);

    const result = await scoreMessage('Arbitrum announces new DeFi lending protocol');

    expect(result).toEqual(expectedResult);
    expect(mockGenerateObject).toHaveBeenCalledOnce();
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'You are a test prompt.',
        prompt: 'Message:\nArbitrum announces new DeFi lending protocol',
        schema: AnalysisSchema,
      }),
    );
  });

  it('includes link content in the prompt', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        relevance_score: 9,
        summary: 'New chain launching.',
        is_relevant: true,
      },
    } as any);

    await scoreMessage(
      'Check out this new chain',
      [{ url: 'https://newchain.io', content: 'We are launching a new L2 rollup' }],
    );

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Linked content from https://newchain.io:'),
      }),
    );
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('We are launching a new L2 rollup'),
      }),
    );
  });

  it('passes message text as the prompt when no links', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        relevance_score: 2,
        summary: 'Not relevant.',
        is_relevant: false,
      },
    } as any);

    const longMessage = 'A very long message about weather and cooking';
    await scoreMessage(longMessage);

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: `Message:\n${longMessage}`,
      }),
    );
  });

  it('propagates errors from generateObject', async () => {
    mockGenerateObject.mockRejectedValue(new Error('API rate limit exceeded'));

    await expect(scoreMessage('test message')).rejects.toThrow(
      'API rate limit exceeded',
    );
  });
});
