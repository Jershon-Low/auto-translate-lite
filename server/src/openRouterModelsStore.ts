import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface OpenRouterModelsStore {
  read(): Promise<string[]>;
  addModel(model: string): Promise<string[]>;
}

function validateModelsList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

export function createOpenRouterModelsStore(filePath: string): OpenRouterModelsStore {
  async function readList(): Promise<string[]> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const validated = validateModelsList(JSON.parse(raw));
      return validated ?? [];
    } catch {
      return [];
    }
  }

  async function writeList(models: string[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(models), 'utf-8');
  }

  return {
    read: readList,
    async addModel(model: string): Promise<string[]> {
      const existing = await readList();
      if (existing.includes(model)) return existing;
      const updated = [...existing, model];
      await writeList(updated);
      return updated;
    },
  };
}
