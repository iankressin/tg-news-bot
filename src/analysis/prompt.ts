import { readFileSync } from 'fs';
import { join } from 'path';

let cachedPrompt: string | null = null;

export function getSystemPrompt(): string {
  if (!cachedPrompt) {
    cachedPrompt = readFileSync(
      join(process.cwd(), 'prompts', 'system.txt'),
      'utf-8',
    );
  }
  return cachedPrompt;
}
