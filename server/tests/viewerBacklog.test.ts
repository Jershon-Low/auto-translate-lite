import { describe, it, expect } from 'vitest';
import { selectBacklogEntriesToTranslate } from '../src/viewerBacklog';
import type { CaptionLine } from '../src/types';

function line(id: string): CaptionLine {
  return { id, timestampMs: 0, english: id, suppressed: false };
}

const cachedNone = () => false;
const cachedAll = () => true;

describe('selectBacklogEntriesToTranslate', () => {
  it('returns only the most recent `limit` entries when more exist and none are cached', () => {
    const entries = ['a', 'b', 'c', 'd', 'e'].map(line);
    const result = selectBacklogEntriesToTranslate(entries, cachedNone, 2);
    expect(result.map((l) => l.id)).toEqual(['d', 'e']);
  });

  it('returns all entries when there are fewer than the limit', () => {
    const entries = ['a', 'b'].map(line);
    const result = selectBacklogEntriesToTranslate(entries, cachedNone, 5);
    expect(result.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('excludes cached entries within the recent window', () => {
    const entries = ['a', 'b', 'c', 'd'].map(line);
    const cached = (l: CaptionLine) => l.id === 'c';
    const result = selectBacklogEntriesToTranslate(entries, cached, 3); // window: b,c,d
    expect(result.map((l) => l.id)).toEqual(['b', 'd']);
  });

  it('returns empty when the whole recent window is already cached', () => {
    const entries = ['a', 'b', 'c'].map(line);
    const result = selectBacklogEntriesToTranslate(entries, cachedAll, 2);
    expect(result).toEqual([]);
  });

  it('excludes an uncached entry older than the recent window', () => {
    const entries = ['old', 'b', 'c'].map(line);
    const cached = (l: CaptionLine) => l.id !== 'old'; // only 'old' is uncached
    const result = selectBacklogEntriesToTranslate(entries, cached, 2); // window: b,c
    expect(result).toEqual([]);
  });

  it('returns empty when limit is 0', () => {
    const entries = ['a', 'b'].map(line);
    expect(selectBacklogEntriesToTranslate(entries, cachedNone, 0)).toEqual([]);
  });
});
