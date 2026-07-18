import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { TRANSLATION_FIXED_RULES, buildTranslateTaskText, buildTranslateBacklogTaskText } from './llmPrompts.js';

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
    contents: buildTranslateTaskText(languageCodes, englishText, precedingContext, instructionBlock),
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
    contents: buildTranslateBacklogTaskText(englishLines, languageCode, instructionBlock),
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
