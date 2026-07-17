import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { TRANSLATION_FIXED_RULES } from './llmPrompts.js';

export interface SermonCacheRef {
  name: string;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiClient {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config: {
        responseMimeType: string;
        responseSchema: Record<string, unknown>;
        cachedContent?: string;
        thinkingConfig?: { thinkingLevel: ThinkingLevel };
      };
    }): Promise<{ text: string | null | undefined; usageMetadata?: GeminiUsageMetadata }>;
  };
  caches: {
    create(params: {
      model: string;
      config: { systemInstruction: string; ttl: string; displayName?: string };
    }): Promise<{ name?: string }>;
    delete(params: { name: string }): Promise<unknown>;
  };
}

export function createGeminiClient(apiKey: string): GeminiClient {
  return new GoogleGenAI({ apiKey });
}

// gemini-3.5-flash defaults to 'medium' thinking, which spends latency on
// reasoning this app doesn't need for short live-caption sentences. Pin it to
// 'minimal' — the fastest setting — since these are simple, high-throughput
// translation/verification calls with no need for extended reasoning.
// gemini-3.1-flash-lite already defaults to 'minimal', so it's left alone.
export function thinkingConfigFor(model: string): { thinkingLevel: ThinkingLevel } | undefined {
  return model === 'gemini-3.5-flash' ? { thinkingLevel: ThinkingLevel.MINIMAL } : undefined;
}

function buildContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (do not translate these — they're for reference only, e.g. to resolve pronouns or match terminology):
${numbered}

`;
}

export async function translateSegment(
  client: GeminiClient,
  model: string,
  englishText: string,
  languageCodes: string[],
  notes: string,
  precedingContext: string[] = [],
  cacheRef: SermonCacheRef | null = null
): Promise<Record<string, string>> {
  if (languageCodes.length === 0) return {};

  const properties: Record<string, { type: string }> = {};
  for (const code of languageCodes) properties[code] = { type: 'string' };

  const instructionBlock = cacheRef ? '' : `${notes}\n\n${TRANSLATION_FIXED_RULES}\n\n`;

  const response = await client.models.generateContent({
    model,
    contents: `Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: ${languageCodes.join(', ')}. Keep the tone natural and spoken, not overly formal.

${instructionBlock}${buildContextBlock(precedingContext)}Sentence: "${englishText}"`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties, required: languageCodes },
      ...(cacheRef ? { cachedContent: cacheRef.name } : {}),
      ...(thinkingConfigFor(model) ? { thinkingConfig: thinkingConfigFor(model) } : {}),
    },
  });

  return JSON.parse(response.text ?? '{}');
}

export async function translateBacklog(
  client: GeminiClient,
  model: string,
  englishLines: string[],
  languageCode: string,
  notes: string,
  cacheRef: SermonCacheRef | null = null
): Promise<string[]> {
  if (englishLines.length === 0) return [];

  const instructionBlock = cacheRef ? '' : `${notes}\n\n${TRANSLATION_FIXED_RULES}\n\n`;

  const response = await client.models.generateContent({
    model,
    contents: `Translate each of these sentences, spoken during a live Australian church sermon, into language code "${languageCode}". Return the translations in the exact same order as the input.

${instructionBlock}Sentences: ${JSON.stringify(englishLines)}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { translations: { type: 'array', items: { type: 'string' } } },
        required: ['translations'],
      },
      ...(cacheRef ? { cachedContent: cacheRef.name } : {}),
      ...(thinkingConfigFor(model) ? { thinkingConfig: thinkingConfigFor(model) } : {}),
    },
  });

  const parsed = JSON.parse(response.text ?? '{"translations":[]}');
  return parsed.translations ?? [];
}
