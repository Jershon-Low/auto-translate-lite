import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logEvent } from './logger.js';

export interface ViewerFeedbackItem {
  id: string;
  sessionId: string;
  timestamp: string;
  language: string;
  lineIndex: number;
  english: string;
  translated: string;
  comment: string;
  downloaded: boolean;
}

export interface ViewerFeedbackStore {
  add(entry: {
    sessionId: string;
    language: string;
    lineIndex: number;
    english: string;
    translated: string;
    comment: string;
  }): ViewerFeedbackItem;
  list(): ViewerFeedbackItem[];
  get(id: string): ViewerFeedbackItem | undefined;
  getUndownloaded(): ViewerFeedbackItem[];
  markDownloaded(ids: string[]): void;
}

function loadItems(filePath: string): ViewerFeedbackItem[] {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      void logEvent('warn', {
        event: 'viewer_feedback_file_load_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
}

export function createViewerFeedbackStore(filePath: string): ViewerFeedbackStore {
  let items: ViewerFeedbackItem[] = loadItems(filePath);

  function persist(): void {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(items), 'utf-8');
    } catch (error) {
      void logEvent('warn', {
        event: 'viewer_feedback_file_write_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    add(entry): ViewerFeedbackItem {
      const item: ViewerFeedbackItem = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        downloaded: false,
        ...entry,
      };
      items = [item, ...items];
      persist();
      return item;
    },
    list(): ViewerFeedbackItem[] {
      return items;
    },
    get(id: string): ViewerFeedbackItem | undefined {
      return items.find((item) => item.id === id);
    },
    getUndownloaded(): ViewerFeedbackItem[] {
      return items.filter((item) => !item.downloaded);
    },
    markDownloaded(ids: string[]): void {
      const idSet = new Set(ids);
      items = items.map((item) => (idSet.has(item.id) ? { ...item, downloaded: true } : item));
      persist();
    },
  };
}
