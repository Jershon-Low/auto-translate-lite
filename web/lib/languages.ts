export interface Language {
  code: string;
  label: string;
}

export const TARGET_LANGUAGES: Language[] = [
  { code: 'zh', label: '中文 (Mandarin)' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'ko', label: '한국어 (Korean)' },
  { code: 'ja', label: '日本語 (Japanese)' },
  { code: 'vi', label: 'Tiếng Việt (Vietnamese)' },
  { code: 'th', label: 'ภาษาไทย (Thai)' },
  { code: 'es', label: 'Español (Spanish)' },
  { code: 'pt', label: 'Português (Portuguese)' },
  { code: 'fr', label: 'Français (French)' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'my', label: 'မြန်မာ (Burmese)' },
];
