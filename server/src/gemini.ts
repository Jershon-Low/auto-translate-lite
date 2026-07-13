import { GoogleGenAI } from '@google/genai';

export interface GeminiClient {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config: { responseMimeType: string; responseSchema: Record<string, unknown> };
    }): Promise<{ text: string | null | undefined }>;
  };
}

export function createGeminiClient(apiKey: string): GeminiClient {
  return new GoogleGenAI({ apiKey });
}

const MODEL = 'gemini-3.1-flash-lite';

export async function translateSegment(
  client: GeminiClient,
  englishText: string,
  languageCodes: string[]
): Promise<Record<string, string>> {
  if (languageCodes.length === 0) return {};

  const properties: Record<string, { type: string }> = {};
  for (const code of languageCodes) properties[code] = { type: 'string' };

  const response = await client.models.generateContent({
    model: MODEL,
    contents: `Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: ${languageCodes.join(', ')}. Keep the tone natural and spoken, not overly formal.

This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she'll be right," "having a go"). Translate for the speaker's intended meaning and tone, not word-for-word — don't flatten idiomatic phrasing into something overly formal, and don't translate slang literally into an unrelated meaning.

Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don't add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.

Sentence: "${englishText}"`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties, required: languageCodes },
    },
  });

  return JSON.parse(response.text ?? '{}');
}

export async function translateBacklog(
  client: GeminiClient,
  englishLines: string[],
  languageCode: string
): Promise<string[]> {
  if (englishLines.length === 0) return [];

  const response = await client.models.generateContent({
    model: MODEL,
    contents: `Translate each of these sentences, spoken during a live Australian church sermon, into language code "${languageCode}". Return the translations in the exact same order as the input.

This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she'll be right," "having a go"). Translate for the speaker's intended meaning and tone, not word-for-word — don't flatten idiomatic phrasing into something overly formal, and don't translate slang literally into an unrelated meaning.

Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don't add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.

Sentences: ${JSON.stringify(englishLines)}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { translations: { type: 'array', items: { type: 'string' } } },
        required: ['translations'],
      },
    },
  });

  const parsed = JSON.parse(response.text ?? '{"translations":[]}');
  return parsed.translations ?? [];
}
