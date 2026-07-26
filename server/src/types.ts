export interface CaptionLine {
  id: string;
  timestampMs: number;
  english: string;
  suppressed: boolean;
  pendingTranslations?: Record<string, string>;
  pending?: boolean;
  reason?: string;
  // True between the moment ingest reserves this line's ordered slot in the
  // buffer and the moment its transcription check comes back. The line exists
  // (so later segments can cite it as preceding context, and so its position
  // is fixed by arrival order) but has never been sent to any client, so
  // backlog snapshots must skip it — see buildBacklogLine/buildReviewBacklogLine.
  // Cleared in place when the verdict is applied. See
  // docs/superpowers/specs/2026-07-26-concurrent-transcription-verification-design.md.
  unverified?: boolean;
}
