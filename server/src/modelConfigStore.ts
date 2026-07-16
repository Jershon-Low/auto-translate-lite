import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MODEL_IDS, type ModelId } from './llmTypes.js';

export interface ModelConfig {
  transcriptionVerifier: ModelId;
  translation: ModelId;
  translationVerifier: ModelId;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  transcriptionVerifier: 'gemini-3.1-flash-lite',
  translation: 'gemini-3.1-flash-lite',
  translationVerifier: 'gemini-3.1-flash-lite',
};

export interface ModelConfigStore {
  read(): Promise<ModelConfig>;
  write(config: ModelConfig): Promise<void>;
}

export function validateModelConfig(value: unknown): ModelConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const roles: (keyof ModelConfig)[] = ['transcriptionVerifier', 'translation', 'translationVerifier'];
  for (const role of roles) {
    if (!MODEL_IDS.includes(candidate[role] as ModelId)) return null;
  }
  return candidate as unknown as ModelConfig;
}

export function createModelConfigStore(filePath: string): ModelConfigStore {
  return {
    async read(): Promise<ModelConfig> {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const validated = validateModelConfig(JSON.parse(raw));
        return validated ?? DEFAULT_MODEL_CONFIG;
      } catch {
        return DEFAULT_MODEL_CONFIG;
      }
    },
    async write(config: ModelConfig): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(config), 'utf-8');
    },
  };
}
