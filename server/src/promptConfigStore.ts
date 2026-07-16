import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  TRANSLATION_DEFAULT_NOTES,
  TRANSCRIPTION_VERIFIER_DEFAULT_NOTES,
  TRANSLATION_VERIFIER_DEFAULT_NOTES,
} from './llmPrompts.js';

export interface PromptConfig {
  transcriptionVerifier: string;
  translation: string;
  translationVerifier: string;
}

export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  transcriptionVerifier: TRANSCRIPTION_VERIFIER_DEFAULT_NOTES,
  translation: TRANSLATION_DEFAULT_NOTES,
  translationVerifier: TRANSLATION_VERIFIER_DEFAULT_NOTES,
};

export interface PromptConfigStore {
  read(): Promise<PromptConfig>;
  write(config: PromptConfig): Promise<void>;
}

export function validatePromptConfig(value: unknown): PromptConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const roles: (keyof PromptConfig)[] = ['transcriptionVerifier', 'translation', 'translationVerifier'];
  for (const role of roles) {
    if (typeof candidate[role] !== 'string') return null;
  }
  return candidate as unknown as PromptConfig;
}

export function createPromptConfigStore(filePath: string): PromptConfigStore {
  return {
    async read(): Promise<PromptConfig> {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const validated = validatePromptConfig(JSON.parse(raw));
        return validated ?? DEFAULT_PROMPT_CONFIG;
      } catch {
        return DEFAULT_PROMPT_CONFIG;
      }
    },
    async write(config: PromptConfig): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(config), 'utf-8');
    },
  };
}
