import type { SermonCacheRef } from './gemini.js';
import type { TranscriptionCheckResult } from './transcriptionVerifier.js';
import type { VerificationItem, VerificationResult } from './translationVerifier.js';

export type ModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';

export const MODEL_IDS: ModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];

export type RoleModelSelection =
  | { provider: 'gemini'; model: ModelId }
  | { provider: 'openrouter'; model: string };

export interface LlmProvider {
  translate(
    englishText: string,
    languageCodes: string[],
    precedingContext: string[],
    cacheRef: SermonCacheRef | null
  ): Promise<Record<string, string>>;
  translateBacklog(englishLines: string[], languageCode: string, cacheRef: SermonCacheRef | null): Promise<string[]>;
  verifyTranscription(
    english: string,
    precedingContext: string[],
    cacheRef: SermonCacheRef | null
  ): Promise<TranscriptionCheckResult>;
  verifyTranslations(
    items: VerificationItem[],
    cacheRef: SermonCacheRef | null
  ): Promise<Record<string, VerificationResult>>;
}

export interface RoleProviders {
  transcriptionVerifier: LlmProvider;
  translation: LlmProvider;
  translationVerifier: LlmProvider;
}
