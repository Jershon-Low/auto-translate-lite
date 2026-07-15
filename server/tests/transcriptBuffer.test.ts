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

  it('append() defaults suppressed to false', () => {
    const buffer = new TranscriptBuffer();
    const line = buffer.append('Hello', 1000);
    expect(line.suppressed).toBe(false);
  });

  it('append() stores an explicit suppressed flag', () => {
    const buffer = new TranscriptBuffer();
    const line = buffer.append('Hidden', 1000, true);
    expect(line.suppressed).toBe(true);
    expect(buffer.getRecent(1000)).toHaveLength(1);
  });

  describe('reinstate', () => {
    it('flips suppressed to false and updates the text, preserving id and position', () => {
      const buffer = new TranscriptBuffer();
      buffer.append('Before', 1000);
      const flagged = buffer.append('Mishe*rd', 2000, true);
      buffer.append('After', 3000);

      const result = buffer.reinstate(flagged.id, 'Corrected text', 4000);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(flagged.id);
      expect(result!.english).toBe('Corrected text');
      expect(result!.suppressed).toBe(false);

      const recent = buffer.getRecent(4000);
      expect(recent.map((line) => line.english)).toEqual(['Before', 'Corrected text', 'After']);
    });

    it('returns null for an unknown id', () => {
      const buffer = new TranscriptBuffer();
      expect(buffer.reinstate('does-not-exist', 'text', 1000)).toBeNull();
    });

    it('returns null for a line that is not currently suppressed', () => {
      const buffer = new TranscriptBuffer();
      const line = buffer.append('Already visible', 1000, false);
      expect(buffer.reinstate(line.id, 'text', 2000)).toBeNull();
    });

    it('returns null once the line has been trimmed out of the 10-minute window', () => {
      const buffer = new TranscriptBuffer();
      const flagged = buffer.append('Old and flagged', 0, true);
      const elevenMinutesLater = 11 * 60 * 1000;
      expect(buffer.reinstate(flagged.id, 'text', elevenMinutesLater)).toBeNull();
    });
  });

  describe('precedingContextFor', () => {
    it('returns the non-suppressed lines before the given id, oldest first', () => {
      const buffer = new TranscriptBuffer();
      buffer.append('Line 1', 1000);
      buffer.append('Line 2', 2000);
      const flagged = buffer.append('Flagged', 3000, true);
      buffer.append('Line 3', 4000);

      expect(buffer.precedingContextFor(flagged.id, 7, 4000)).toEqual(['Line 1', 'Line 2']);
    });

    it('caps the result at maxLines, keeping the most recent', () => {
      const buffer = new TranscriptBuffer();
      for (let i = 1; i <= 9; i += 1) buffer.append(`Line ${i}`, i * 1000);
      const target = buffer.append('Target', 10000);

      expect(buffer.precedingContextFor(target.id, 7, 10000)).toEqual([
        'Line 3', 'Line 4', 'Line 5', 'Line 6', 'Line 7', 'Line 8', 'Line 9',
      ]);
    });

    it('returns an empty array for an unknown id', () => {
      const buffer = new TranscriptBuffer();
      buffer.append('Line 1', 1000);
      expect(buffer.precedingContextFor('unknown', 7, 1000)).toEqual([]);
    });
  });
});
