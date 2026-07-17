import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type TranslationFlagDisplayMode = 'hide' | 'flag';

export interface TranslationFlagDisplayConfig {
  mode: TranslationFlagDisplayMode;
}

export const DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG: TranslationFlagDisplayConfig = { mode: 'hide' };

export interface TranslationFlagDisplayStore {
  read(): Promise<TranslationFlagDisplayConfig>;
  write(config: TranslationFlagDisplayConfig): Promise<void>;
}

export function validateTranslationFlagDisplayConfig(value: unknown): TranslationFlagDisplayConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== 'hide' && candidate.mode !== 'flag') return null;
  return { mode: candidate.mode };
}

export function createTranslationFlagDisplayStore(filePath: string): TranslationFlagDisplayStore {
  return {
    async read(): Promise<TranslationFlagDisplayConfig> {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const validated = validateTranslationFlagDisplayConfig(JSON.parse(raw));
        return validated ?? DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG;
      } catch {
        return DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG;
      }
    },
    async write(config: TranslationFlagDisplayConfig): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(config), 'utf-8');
    },
  };
}
