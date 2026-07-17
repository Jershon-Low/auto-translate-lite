import { describe, it, expect } from 'vitest';
import { TranslationCache } from '../src/translationCache';

describe('TranslationCache', () => {
  it('returns undefined for a line that was never cached', () => {
    const cache = new TranslationCache();
    expect(cache.get('zh', 'line-1')).toBeUndefined();
  });

  it('set/get roundtrips a translated line for a given language', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', { translated: '你好', flagged: false });
    expect(cache.get('zh', 'line-1')).toEqual({ translated: '你好', flagged: false });
  });

  it('roundtrips a flagged entry including its reason', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', { translated: '耶稣不爱你', flagged: true, reason: 'polarity flip' });
    expect(cache.get('zh', 'line-1')).toEqual({ translated: '耶稣不爱你', flagged: true, reason: 'polarity flip' });
  });

  it('keeps the same line id independent across different languages', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', { translated: '你好', flagged: false });
    cache.set('fr', 'line-1', { translated: 'Bonjour', flagged: false });
    expect(cache.get('zh', 'line-1')).toEqual({ translated: '你好', flagged: false });
    expect(cache.get('fr', 'line-1')).toEqual({ translated: 'Bonjour', flagged: false });
  });

  it('overwrites a previously cached value for the same language and line id', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', { translated: '你好', flagged: false });
    cache.set('zh', 'line-1', { translated: '你好呀', flagged: false });
    expect(cache.get('zh', 'line-1')).toEqual({ translated: '你好呀', flagged: false });
  });

  it('clear() empties every language', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', { translated: '你好', flagged: false });
    cache.set('fr', 'line-1', { translated: 'Bonjour', flagged: false });
    cache.clear();
    expect(cache.get('zh', 'line-1')).toBeUndefined();
    expect(cache.get('fr', 'line-1')).toBeUndefined();
  });
});
