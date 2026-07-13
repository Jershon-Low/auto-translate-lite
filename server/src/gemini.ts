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
    contents: `Translate the following sentence, spoken during a live church sermon, into each of these language codes: ${languageCodes.join(', ')}. Keep the tone natural and spoken, not overly formal. Sentence: "${englishText}"`,
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
    contents: `Translate each of these sentences, spoken during a live church sermon, into language code "${languageCode}". Return the translations in the exact same order as the input. Sentences: ${JSON.stringify(englishLines)}`,
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
