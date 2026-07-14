import type { GeminiClient, SermonCacheRef } from './gemini.js';

const MODEL = 'gemini-3.1-flash-lite';
const CACHE_TTL = '7200s';
const MIN_CACHEABLE_CHARS = 200;

export function buildSermonContextInstruction(feedbackText: string, sermonText: string): string {
  const sections: string[] = [];
  const trimmedFeedback = feedbackText.trim();
  if (trimmedFeedback.length > 0) {
    sections.push(
      `Known corrections from past sessions (avoid repeating these specific mistakes):\n${trimmedFeedback}`
    );
  }
  sections.push(
    `This week's sermon material (for reference only, e.g. names, scripture references, terminology):\n${sermonText.trim()}`
  );
  return sections.join('\n\n');
}

export async function createSermonContextCache(
  client: GeminiClient,
  feedbackText: string,
  sermonText: string
): Promise<SermonCacheRef | null> {
  const instruction = buildSermonContextInstruction(feedbackText, sermonText);
  if (instruction.length < MIN_CACHEABLE_CHARS) return null;

  try {
    const cache = await client.caches.create({
      model: MODEL,
      config: { systemInstruction: instruction, ttl: CACHE_TTL, displayName: 'sermon-context' },
    });
    return cache.name ? { name: cache.name } : null;
  } catch (error) {
    console.error('Failed to create sermon context cache, continuing without it:', error);
    return null;
  }
}

export async function deleteSermonContextCache(
  client: GeminiClient,
  cacheRef: SermonCacheRef | null
): Promise<void> {
  if (!cacheRef) return;
  try {
    await client.caches.delete({ name: cacheRef.name });
  } catch (error) {
    console.error('Failed to delete sermon context cache:', error);
  }
}
