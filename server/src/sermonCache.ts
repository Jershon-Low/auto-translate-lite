import type { GeminiClient, SermonCacheRef } from './gemini.js';
import type { ModelConfig } from './modelConfigStore.js';
import type { PromptConfig } from './promptConfigStore.js';
import {
  TRANSLATION_FIXED_RULES,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO,
  TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_INTRO,
  TRANSLATION_VERIFIER_FIXED_RULES_OUTRO,
} from './llmPrompts.js';
import { logEvent } from './logger.js';

const CACHE_TTL = '7200s';
const MIN_CACHEABLE_CHARS = 200;

export interface RoleCaches {
  transcriptionVerifier: SermonCacheRef | null;
  translation: SermonCacheRef | null;
  translationVerifier: SermonCacheRef | null;
}

function buildSharedContextBlock(feedbackText: string, sermonText: string): string {
  const sections: string[] = [];
  const trimmedFeedback = feedbackText.trim();
  if (trimmedFeedback.length > 0) {
    sections.push(
      `Known corrections from past sessions (avoid repeating these specific mistakes):\n${trimmedFeedback}`
    );
  }
  const trimmedSermon = sermonText.trim();
  if (trimmedSermon.length > 0) {
    sections.push(`This week's sermon material (for reference only, e.g. names, scripture references, terminology):\n${trimmedSermon}`);
  }
  return sections.join('\n\n');
}

async function createOneRoleCache(
  client: GeminiClient,
  model: string,
  fixedAndNotes: string,
  sharedContext: string,
  displayName: string
): Promise<SermonCacheRef | null> {
  const instruction = sharedContext.length > 0 ? `${fixedAndNotes}\n\n${sharedContext}` : fixedAndNotes;
  if (instruction.length < MIN_CACHEABLE_CHARS) return null;

  try {
    const cache = await client.caches.create({
      model,
      config: { systemInstruction: instruction, ttl: CACHE_TTL, displayName },
    });
    return cache.name ? { name: cache.name } : null;
  } catch (error) {
    void logEvent('error', {
      event: 'role_cache_create_failed',
      role: displayName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function createRoleCaches(
  client: GeminiClient,
  modelConfig: ModelConfig,
  promptConfig: PromptConfig,
  feedbackText: string,
  sermonText: string
): Promise<RoleCaches> {
  const sharedContext = buildSharedContextBlock(feedbackText, sermonText);

  const [transcriptionVerifier, translation, translationVerifier] = await Promise.all([
    createOneRoleCache(
      client,
      modelConfig.transcriptionVerifier,
      `${TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO}\n\n${promptConfig.transcriptionVerifier}\n\n${TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO}`,
      sharedContext,
      'transcription-verifier-context'
    ),
    createOneRoleCache(
      client,
      modelConfig.translation,
      `${promptConfig.translation}\n\n${TRANSLATION_FIXED_RULES}`,
      sharedContext,
      'translation-context'
    ),
    createOneRoleCache(
      client,
      modelConfig.translationVerifier,
      `${TRANSLATION_VERIFIER_FIXED_RULES_INTRO}\n\n${promptConfig.translationVerifier}\n\n${TRANSLATION_VERIFIER_FIXED_RULES_OUTRO}`,
      sharedContext,
      'translation-verifier-context'
    ),
  ]);

  return { transcriptionVerifier, translation, translationVerifier };
}

export async function deleteRoleCaches(client: GeminiClient, caches: RoleCaches): Promise<void> {
  const refs = [caches.transcriptionVerifier, caches.translation, caches.translationVerifier].filter(
    (ref): ref is SermonCacheRef => ref !== null
  );
  await Promise.all(
    refs.map((ref) =>
      client.caches.delete({ name: ref.name }).catch((error) => {
        void logEvent('error', {
          event: 'role_cache_delete_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      })
    )
  );
}
