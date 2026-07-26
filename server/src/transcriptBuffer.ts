import { randomUUID } from 'node:crypto';
import type { CaptionLine } from './types.js';

const BUFFER_WINDOW_MS = 10 * 60 * 1000;

export class TranscriptBuffer {
  private lines: CaptionLine[] = [];

  append(
    english: string,
    timestampMs: number = Date.now(),
    suppressed: boolean = false,
    pendingTranslations?: Record<string, string>,
    pending?: boolean,
    reason?: string
  ): CaptionLine {
    const line: CaptionLine = {
      id: randomUUID(),
      timestampMs,
      english,
      suppressed,
      pendingTranslations,
      pending,
      reason,
    };
    this.lines.push(line);
    this.trim(timestampMs);
    return line;
  }

  // Reserves an ordered slot for a segment whose transcription check hasn't
  // come back yet, so verification can run concurrently without letting a
  // faster later segment overtake a slower earlier one. The line counts as
  // preceding context immediately — its text is what was heard, checked or
  // not — but `unverified` keeps it out of backlog snapshots until
  // applyVerdict runs, because it has not been broadcast to anyone yet.
  reserve(english: string, timestampMs: number = Date.now()): CaptionLine {
    const line = this.append(english, timestampMs, false);
    line.unverified = true;
    return line;
  }

  // Applies a transcription verdict to a reserved line, in place. Takes the
  // object reserve handed out rather than an id: trim may have dropped the
  // line from the window while its check was in flight, and the verdict still
  // has to land on it (the publish path holds the same reference).
  //
  // Only ever sets `suppressed`, never clears it: an admin remove that landed
  // during the check has already told viewers the line is gone, and a `safe`
  // verdict arriving afterwards must not resurrect it.
  applyVerdict(line: CaptionLine, verdict: { suppressed: boolean; pending?: boolean; reason?: string }): void {
    line.unverified = undefined;
    if (!verdict.suppressed || line.suppressed) return;
    line.suppressed = true;
    line.pending = verdict.pending;
    line.reason = verdict.reason;
  }

  peek(id: string, nowMs: number = Date.now()): CaptionLine | null {
    this.trim(nowMs);
    return this.lines.find((candidate) => candidate.id === id) ?? null;
  }

  getRecent(nowMs: number = Date.now()): CaptionLine[] {
    this.trim(nowMs);
    return [...this.lines];
  }

  reinstate(id: string, english: string, nowMs: number = Date.now()): CaptionLine | null {
    this.trim(nowMs);
    const line = this.lines.find((candidate) => candidate.id === id && candidate.suppressed);
    if (!line) return null;
    line.english = english;
    line.suppressed = false;
    line.pending = undefined;
    line.reason = undefined;
    return line;
  }

  suppress(id: string, nowMs: number = Date.now()): CaptionLine | null {
    this.trim(nowMs);
    const line = this.lines.find((candidate) => candidate.id === id && !candidate.suppressed);
    if (!line) return null;
    line.suppressed = true;
    line.reason = 'Removed by admin';
    return line;
  }

  precedingContextFor(id: string, maxLines: number, nowMs: number = Date.now()): string[] {
    this.trim(nowMs);
    const index = this.lines.findIndex((line) => line.id === id);
    if (index === -1) return [];
    return this.lines
      .slice(0, index)
      .filter((line) => !line.suppressed)
      .slice(-maxLines)
      .map((line) => line.english);
  }

  clear(): void {
    this.lines = [];
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - BUFFER_WINDOW_MS;
    this.lines = this.lines.filter((line) => line.timestampMs >= cutoff);
  }
}
