import type { GeminiClient, SermonCacheRef } from './gemini.js';
import { TRANSLATION_VERIFIER_FIXED_RULES_INTRO, TRANSLATION_VERIFIER_FIXED_RULES_OUTRO } from './llmPrompts.js';

export interface VerificationItem {
  id: string;
  english: string;
  translated: string;
}

export interface VerificationResult {
  safe: boolean;
  reason: string;
}

export async function verifyTranslations(
  client: GeminiClient,
  model: string,
  items: VerificationItem[],
  notes: string,
  cacheRef: SermonCacheRef | null = null
): Promise<Record<string, VerificationResult>> {
  if (items.length === 0) return {};

  const properties: Record<string, Record<string, unknown>> = {};
  for (const item of items) {
    properties[item.id] = {
      type: 'object',
      properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['safe', 'reason'],
    };
  }

  const pairs = items
    .map(
      (item, index) =>
        `${index + 1}. [id: "${item.id}"] English: "${item.english}" | Translation: "${item.translated}"`
    )
    .join('\n');

  const instructionBlock = cacheRef
    ? ''
    : `${TRANSLATION_VERIFIER_FIXED_RULES_INTRO}\n\n${notes}\n\n${TRANSLATION_VERIFIER_FIXED_RULES_OUTRO}\n\n`;

  const response = await client.models.generateContent({
    model,
    contents: `This is a safety checker for live captions at an Australian church sermon.

${instructionBlock}Pairs:
${pairs}

Return, for each id, whether it is safe and a short reason.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties, required: items.map((item) => item.id) },
      ...(cacheRef ? { cachedContent: cacheRef.name } : {}),
    },
  });

  const parsed: unknown = JSON.parse(response.text ?? '{}');
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, VerificationResult>) : {};
}
