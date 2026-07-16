import type { GeminiClient, SermonCacheRef } from './gemini.js';
import { TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO, TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO } from './llmPrompts.js';

export interface TranscriptionCheckResult {
  safe: boolean;
  reason: string;
}

function buildContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (not to be evaluated themselves — only for resolving pronouns or continuing a thought):\n${numbered}\n\n`;
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

  const response = await client.models.generateContent({
    model,
    contents: `This is a transcription accuracy checker for live captions at an Australian church sermon.

${instructionBlock}${buildContextBlock(precedingContext)}Line: "${english}"

Return whether it is safe and a short reason.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['safe', 'reason'],
      },
      ...(cacheRef ? { cachedContent: cacheRef.name } : {}),
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
