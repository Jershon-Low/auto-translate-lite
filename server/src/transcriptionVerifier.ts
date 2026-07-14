import type { GeminiClient, SermonCacheRef } from './gemini.js';

export interface TranscriptionCheckResult {
  safe: boolean;
  reason: string;
}

const MODEL = 'gemini-3.1-flash-lite';

function buildContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (not to be evaluated themselves — only for resolving pronouns or continuing a thought):\n${numbered}\n\n`;
}

export async function verifyTranscription(
  client: GeminiClient,
  english: string,
  precedingContext: string[] = [],
  sermonCache: SermonCacheRef | null = null
): Promise<TranscriptionCheckResult> {
  const response = await client.models.generateContent({
    model: MODEL,
    contents: `You are a transcription accuracy checker for live captions at an Australian church sermon. This line was auto-transcribed live from spoken audio by speech-to-text, which occasionally mishears a word — dropping or inserting a "not", mishearing a name, or similar. Decide whether this line, taken at face value, confidently states something false about God, Jesus, the Holy Spirit, or core Christian belief.

Do NOT flag a line just because it is idiomatic, informal, or grammatically rough — this sermon includes Australian slang, jokes, and dry humor (e.g. "no worries," "arvo," "having a go," "she'll be right"), and normal spoken imperfection is expected and not a sign of an error.

Only mark it unsafe if the line, as transcribed, clearly and confidently misrepresents who God, Jesus, or the Holy Spirit is or does — the kind of thing a dropped or inserted "not" would cause.

${buildContextBlock(precedingContext)}Line: "${english}"

Return whether it is safe and a short reason.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { safe: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['safe', 'reason'],
      },
      ...(sermonCache ? { cachedContent: sermonCache.name } : {}),
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
