import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { getSystemPrompt } from './prompt.js';
import { logger } from '../utils/logger.js';
import type { FetchedLink } from './link-fetcher.js';

export const AnalysisSchema = z.object({
  relevance_score: z
    .number()
    .min(0)
    .max(10)
    .describe(
      'How relevant this content is to new blockchain/DeFi launches, 0=irrelevant, 10=perfect lead',
    ),
  summary: z
    .string()
    .describe('One sentence explaining why this is relevant for sqd.ai sales'),
  is_relevant: z.boolean().describe('True if relevance_score > 5'),
});

export type AnalysisResult = z.infer<typeof AnalysisSchema>;

export function buildPrompt(
  messageText: string,
  linkContents?: FetchedLink[],
): string {
  let prompt = `Message:\n${messageText}`;

  if (linkContents && linkContents.length > 0) {
    for (const link of linkContents) {
      prompt += `\n\n---\nLinked content from ${link.url}:\n${link.content}`;
    }
  }

  return prompt;
}

export async function scoreMessage(
  messageText: string,
  linkContents?: FetchedLink[],
  model?: string,
): Promise<AnalysisResult> {
  const systemPrompt = getSystemPrompt();
  const modelId = model || process.env.LLM_MODEL || 'claude-sonnet-4-20250514';
  const prompt = buildPrompt(messageText, linkContents);

  logger.debug('Scoring message with LLM', {
    modelId,
    textLength: messageText.length,
    linkCount: linkContents?.length ?? 0,
    promptLength: prompt.length,
  });

  const { object } = await generateObject({
    model: anthropic(modelId),
    schema: AnalysisSchema,
    system: systemPrompt,
    prompt,
  });

  return object;
}
