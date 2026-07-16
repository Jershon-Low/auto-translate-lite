import { translateSegment, translateBacklog, type GeminiClient, type SermonCacheRef } from './gemini.js';
import { verifyTranscription, type TranscriptionCheckResult } from './transcriptionVerifier.js';
import { verifyTranslations, type VerificationItem, type VerificationResult } from './translationVerifier.js';
import type { LlmProvider, ModelId } from './llmTypes.js';

export class GeminiProvider implements LlmProvider {
  constructor(
    private readonly client: GeminiClient,
    private readonly model: ModelId,
    private readonly notes: string
  ) {}

  translate(
    englishText: string,
    languageCodes: string[],
    precedingContext: string[],
    cacheRef: SermonCacheRef | null
  ): Promise<Record<string, string>> {
    return translateSegment(this.client, this.model, englishText, languageCodes, this.notes, precedingContext, cacheRef);
  }

  translateBacklog(englishLines: string[], languageCode: string, cacheRef: SermonCacheRef | null): Promise<string[]> {
    return translateBacklog(this.client, this.model, englishLines, languageCode, this.notes, cacheRef);
  }

  verifyTranscription(
    english: string,
    precedingContext: string[],
    cacheRef: SermonCacheRef | null
  ): Promise<TranscriptionCheckResult> {
    return verifyTranscription(this.client, this.model, english, this.notes, precedingContext, cacheRef);
  }

  verifyTranslations(
    items: VerificationItem[],
    cacheRef: SermonCacheRef | null
  ): Promise<Record<string, VerificationResult>> {
    return verifyTranslations(this.client, this.model, items, this.notes, cacheRef);
  }
}
