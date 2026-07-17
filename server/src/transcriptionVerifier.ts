import { thinkingConfigFor, type GeminiClient, type SermonCacheRef } from './gemini.js';
import {
  TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO,
  buildTranscriptionVerifierTaskText,
} from './llmPrompts.js';

export interface TranscriptionCheckResult {
  safe: boolean;
  reason: string;
}

export async function verifyTranscription(
  client: GeminiClient,
  model: string,
  english: string,
  notes: string,
  precedingContext: string[] = [],
  cacheRef: SermonCacheRef | null = null
): Promise<TranscriptionCheckResult> {
  const instructionBlock = cacheRef
    ? ''
    : `${TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO}\n\n${notes}\n\n${TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO}\n\n`;
  // The marker sentence below only exists so the wsServer.ts test double can route fake
  // responses by matching a substring in `contents`. When cacheRef is set, `instructionBlock`
  // is empty (the INTRO text lives in the cache's systemInstruction instead), so the marker is
  // needed to keep that substring present. When cacheRef is null, `instructionBlock` already
  // starts with the INTRO text containing the same substring, so omit the marker to avoid
  // duplicating it and keep the uncached prompt byte-identical to before this refactor.
  const cacheRouterMarker = cacheRef ? 'This is a transcription accuracy checker for live captions at an Australian church sermon.\n\n' : '';

  const response = await client.models.generateContent({
    model,
    contents: `${cacheRouterMarker}${instructionBlock}${buildTranscriptionVerifierTaskText(english, precedingContext)}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['safe', 'reason'],
      },
      ...(cacheRef ? { cachedContent: cacheRef.name } : {}),
      ...(thinkingConfigFor(model) ? { thinkingConfig: thinkingConfigFor(model) } : {}),
    },
  });

  const parsed: unknown = JSON.parse(response.text ?? '{}');
  if (
    parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as Record<string, unknown>).safe === 'boolean' &&
    typeof (parsed as Record<string, unknown>).reason === 'string'
  ) {
    return parsed as TranscriptionCheckResult;
  }
  return { safe: false, reason: 'malformed response' };
}
