import { describe, it, expect } from 'vitest';
import { TranscriptBuffer } from '../src/transcriptBuffer';

describe('TranscriptBuffer', () => {
  it('returns appended lines in order', () => {
    const buffer = new TranscriptBuffer();
    buffer.append('Hello', 1000);
    buffer.append('World', 2000);
    expect(buffer.getRecent(2000).map((l) => l.english)).toEqual(['Hello', 'World']);
  });

  it('drops lines older than the 10-minute window', () => {
    const buffer = new TranscriptBuffer();
    buffer.append('Old', 0);
    buffer.append('Recent', 5 * 60 * 1000);
    const nowMs = 11 * 60 * 1000;
    expect(buffer.getRecent(nowMs).map((l) => l.english)).toEqual(['Recent']);
  });

  it('clear() empties the buffer', () => {
    const buffer = new TranscriptBuffer();
    buffer.append('Hello', 1000);
    buffer.clear();
    expect(buffer.getRecent(1000)).toEqual([]);
  });
});
