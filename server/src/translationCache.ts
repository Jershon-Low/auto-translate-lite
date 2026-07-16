export class TranslationCache {
  private byLanguage: Map<string, Map<string, string>> = new Map();

  get(language: string, lineId: string): string | undefined {
    return this.byLanguage.get(language)?.get(lineId);
  }

  set(language: string, lineId: string, translated: string): void {
    let lines = this.byLanguage.get(language);
    if (!lines) {
      lines = new Map();
      this.byLanguage.set(language, lines);
    }
    lines.set(lineId, translated);
  }

  clear(): void {
    this.byLanguage.clear();
  }
}
