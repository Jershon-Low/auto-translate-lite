import { randomUUID } from 'node:crypto';
import type { CaptionLine } from './types.js';

const BUFFER_WINDOW_MS = 10 * 60 * 1000;

export class TranscriptBuffer {
  private lines: CaptionLine[] = [];

  append(english: string, timestampMs: number = Date.now()): CaptionLine {
    const line: CaptionLine = { id: randomUUID(), timestampMs, english };
    this.lines.push(line);
    this.trim(timestampMs);
    return line;
  }

  getRecent(nowMs: number = Date.now()): CaptionLine[] {
    this.trim(nowMs);
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - BUFFER_WINDOW_MS;
    this.lines = this.lines.filter((line) => line.timestampMs >= cutoff);
  }
}
