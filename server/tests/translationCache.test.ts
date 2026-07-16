import { describe, it, expect } from 'vitest';
import { TranslationCache } from '../src/translationCache';

describe('TranslationCache', () => {
  it('returns undefined for a line that was never cached', () => {
    const cache = new TranslationCache();
    expect(cache.get('zh', 'line-1')).toBeUndefined();
  });

  it('set/get roundtrips a translated line for a given language', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', '你好');
    expect(cache.get('zh', 'line-1')).toBe('你好');
  });

  it('keeps the same line id independent across different languages', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', '你好');
    cache.set('fr', 'line-1', 'Bonjour');
    expect(cache.get('zh', 'line-1')).toBe('你好');
    expect(cache.get('fr', 'line-1')).toBe('Bonjour');
  });

  it('overwrites a previously cached value for the same language and line id', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', '你好');
    cache.set('zh', 'line-1', '你好呀');
    expect(cache.get('zh', 'line-1')).toBe('你好呀');
  });

  it('clear() empties every language', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', '你好');
    cache.set('fr', 'line-1', 'Bonjour');
    cache.clear();
    expect(cache.get('zh', 'line-1')).toBeUndefined();
    expect(cache.get('fr', 'line-1')).toBeUndefined();
  });
});
