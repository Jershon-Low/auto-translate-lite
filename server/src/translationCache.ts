export interface CachedTranslation {
  translated: string;
  flagged: boolean;
  reason?: string;
}

export class TranslationCache {
  private byLanguage: Map<string, Map<string, CachedTranslation>> = new Map();

  get(language: string, lineId: string): CachedTranslation | undefined {
    return this.byLanguage.get(language)?.get(lineId);
  }

  set(language: string, lineId: string, entry: CachedTranslation): void {
    let lines = this.byLanguage.get(language);
    if (!lines) {
      lines = new Map();
      this.byLanguage.set(language, lines);
    }
    lines.set(lineId, entry);
  }

  clear(): void {
    this.byLanguage.clear();
  }
}
