export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event?: string;
  [key: string]: unknown;
}

export interface LogHub {
  push(entry: LogEntry): void;
  getHistory(): LogEntry[];
  subscribe(listener: (entry: LogEntry) => void): () => void;
}

export function createLogHub(bufferSize = 500): LogHub {
  const buffer: LogEntry[] = [];
  const listeners = new Set<(entry: LogEntry) => void>();

  return {
    push(entry) {
      buffer.push(entry);
      if (buffer.length > bufferSize) {
        buffer.shift();
      }
      for (const listener of listeners) {
        try {
          listener(entry);
        } catch {
          // A subscriber must never break logging or the other subscribers.
          // Its failure is swallowed here; logEvent's own error paths remain
          // the app's real signal.
        }
      }
    },
    getHistory() {
      return [...buffer];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Default process-wide singleton: logger.ts pushes into it, wsServer subscribes.
export const logHub = createLogHub();
