import type { GeminiClient, SermonCacheRef } from './gemini.js';

export interface VerificationItem {
  id: string;
  english: string;
  translated: string;
}

export interface VerificationResult {
  safe: boolean;
  reason: string;
}

const MODEL = 'gemini-3.1-flash-lite';

export async function verifyTranslations(
  client: GeminiClient,
  items: VerificationItem[],
  sermonCache: SermonCacheRef | null = null
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

  const response = await client.models.generateContent({
    model: MODEL,
    contents: `You are a safety checker for live captions at an Australian church sermon. For each numbered pair below, decide whether the translation is safe to show: it must preserve the original's meaning and polarity, and must not misrepresent who God, Jesus, or the Holy Spirit is or does.

Do NOT flag a translation just because it is idiomatic or non-literal — this sermon includes Australian slang, jokes, and dry humor (e.g. "no worries," "arvo," "having a go," "she'll be right"), and a natural, non-literal rendering of those is expected and correct.

Only mark a translation unsafe if it inverts a positive statement into a negative one (or vice versa), negates or contradicts the original, reverses who is doing or receiving an action, or misrepresents God/Jesus/the Holy Spirit.

Pairs:
${pairs}

Return, for each id, whether it is safe and a short reason.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties, required: items.map((item) => item.id) },
      ...(sermonCache ? { cachedContent: sermonCache.name } : {}),
    },
  });

  const parsed: unknown = JSON.parse(response.text ?? '{}');
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, VerificationResult>) : {};
}
