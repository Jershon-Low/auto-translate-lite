import { thinkingConfigFor, type GeminiClient, type SermonCacheRef } from './gemini.js';
import {
  TRANSLATION_VERIFIER_FIXED_RULES_INTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_OUTRO,
  buildTranslationVerifierTaskText,
} from './llmPrompts.js';

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

  const instructionBlock = cacheRef
    ? ''
    : `${TRANSLATION_VERIFIER_FIXED_RULES_INTRO}\n\n${notes}\n\n${TRANSLATION_VERIFIER_FIXED_RULES_OUTRO}\n\n`;
  // The marker sentence below only exists so the wsServer.ts test double can route fake
  // responses by matching a substring in `contents`. When cacheRef is set, `instructionBlock`
  // is empty (the INTRO text lives in the cache's systemInstruction instead), so the marker is
  // needed to keep that substring present. When cacheRef is null, `instructionBlock` already
  // starts with the INTRO text containing the same substring, so omit the marker to avoid
  // duplicating it and keep the uncached prompt byte-identical to before this refactor.
  const cacheRouterMarker = cacheRef ? 'This is a safety checker for live captions at an Australian church sermon.\n\n' : '';

  const response = await client.models.generateContent({
    model,
    contents: `${cacheRouterMarker}${instructionBlock}${buildTranslationVerifierTaskText(items)}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties, required: items.map((item) => item.id) },
      ...(cacheRef ? { cachedContent: cacheRef.name } : {}),
      ...(thinkingConfigFor(model) ? { thinkingConfig: thinkingConfigFor(model) } : {}),
    },
  });

  const parsed: unknown = JSON.parse(response.text ?? '{}');
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, VerificationResult>) : {};
}
