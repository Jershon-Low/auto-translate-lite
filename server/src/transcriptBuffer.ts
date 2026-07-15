import { randomUUID } from 'node:crypto';
import type { CaptionLine } from './types.js';

const BUFFER_WINDOW_MS = 10 * 60 * 1000;

export class TranscriptBuffer {
  private lines: CaptionLine[] = [];

  append(english: string, timestampMs: number = Date.now(), suppressed: boolean = false): CaptionLine {
    const line: CaptionLine = { id: randomUUID(), timestampMs, english, suppressed };
    this.lines.push(line);
    this.trim(timestampMs);
    return line;
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
