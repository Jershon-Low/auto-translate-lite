import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FeedbackStore {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

export function createFeedbackStore(filePath: string): FeedbackStore {
  return {
    async read(): Promise<string> {
      try {
        return await readFile(filePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    },
    async write(text: string): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, text, 'utf-8');
    },
  };
}
