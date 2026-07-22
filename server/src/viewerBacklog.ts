import type { CaptionLine } from './types.js';

// Of the visible backlog, return only the most-recent `limit` lines that are
// still uncached for the target language. Older lines are intentionally
// excluded — they fall back to their English text in the backlog snapshot
// rather than being translated — which bounds the size (and cost/latency) of a
// single on-subscribe backlog fill. See
// docs/superpowers/specs/2026-07-21-backlog-translation-cap-design.md.
export function selectBacklogEntriesToTranslate(
  visibleEntries: CaptionLine[],
  isCached: (line: CaptionLine) => boolean,
  limit: number
): CaptionLine[] {
  const recent = limit > 0 ? visibleEntries.slice(-limit) : [];
  return recent.filter((line) => !isCached(line));
}
