export interface CaptionLine {
  id: string;
  timestampMs: number;
  english: string;
  suppressed: boolean;
  pendingTranslations?: Record<string, string>;
}
