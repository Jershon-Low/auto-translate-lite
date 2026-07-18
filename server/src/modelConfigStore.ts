import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MODEL_IDS, type ModelId, type OpenRouterReasoningEffort, type RoleModelSelection } from './llmTypes.js';

const OPENROUTER_REASONING_EFFORTS: OpenRouterReasoningEffort[] = ['off', 'low', 'medium', 'high'];

export interface ModelConfig {
  transcriptionVerifier: RoleModelSelection;
  translation: RoleModelSelection;
  translationVerifier: RoleModelSelection;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  transcriptionVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
  translation: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
  translationVerifier: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
};

export interface ModelConfigStore {
  read(): Promise<ModelConfig>;
  write(config: ModelConfig): Promise<void>;
}

function normalizeRoleSelection(value: unknown): RoleModelSelection | null {
  if (typeof value === 'string') {
    // Legacy on-disk/PUT format: a bare Gemini model id string.
    return MODEL_IDS.includes(value as ModelId) ? { provider: 'gemini', model: value as ModelId } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.provider === 'gemini') {
    return MODEL_IDS.includes(candidate.model as ModelId) ? { provider: 'gemini', model: candidate.model as ModelId } : null;
  }
  if (candidate.provider === 'openrouter') {
    if (typeof candidate.model !== 'string' || candidate.model.length === 0) return null;
    if (candidate.reasoning === undefined) {
      return { provider: 'openrouter', model: candidate.model };
    }
    if (!OPENROUTER_REASONING_EFFORTS.includes(candidate.reasoning as OpenRouterReasoningEffort)) return null;
    return { provider: 'openrouter', model: candidate.model, reasoning: candidate.reasoning as OpenRouterReasoningEffort };
  }
  return null;
}

export function validateModelConfig(value: unknown): ModelConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const roles: (keyof ModelConfig)[] = ['transcriptionVerifier', 'translation', 'translationVerifier'];
  const result = {} as ModelConfig;
  for (const role of roles) {
    const normalized = normalizeRoleSelection(candidate[role]);
    if (!normalized) return null;
    result[role] = normalized;
  }
  return result;
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
