export interface SermonDocStore {
  set(text: string): void;
  get(): string | null;
  clear(): void;
}

export function createSermonDocStore(): SermonDocStore {
  let text: string | null = null;
  return {
    set: (value: string) => {
      text = value;
    },
    get: () => text,
    clear: () => {
      text = null;
    },
  };
}
