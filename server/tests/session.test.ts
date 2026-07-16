import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { Session } from '../src/session';

function fakeSocket(): WebSocket {
  return {} as WebSocket;
}

describe('Session', () => {
  it('tracks the set of active languages across connected viewers', () => {
    const session = new Session();
    session.addViewer(fakeSocket(), 'zh');
    session.addViewer(fakeSocket(), 'ko');
    expect(session.getActiveLanguages().sort()).toEqual(['ko', 'zh']);
  });

  it('deduplicates languages shared by multiple viewers', () => {
    const session = new Session();
    session.addViewer(fakeSocket(), 'zh');
    session.addViewer(fakeSocket(), 'zh');
    expect(session.getActiveLanguages()).toEqual(['zh']);
  });

  it('removes a viewer from active language tracking on disconnect', () => {
    const session = new Session();
    const socket = fakeSocket();
    session.addViewer(socket, 'zh');
    session.removeViewer(socket);
    expect(session.getActiveLanguages()).toEqual([]);
  });

  it('returns only the viewers subscribed to a given language', () => {
    const session = new Session();
    const zhSocket = fakeSocket();
    const koSocket = fakeSocket();
    session.addViewer(zhSocket, 'zh');
    session.addViewer(koSocket, 'ko');
    expect(session.getViewersForLanguage('zh')).toEqual([zhSocket]);
  });

  it('switchViewerLanguage moves a viewer to a new language', () => {
    const session = new Session();
    const socket = fakeSocket();
    session.addViewer(socket, 'zh');
    session.switchViewerLanguage(socket, 'ko');
    expect(session.getViewersForLanguage('zh')).toEqual([]);
    expect(session.getViewersForLanguage('ko')).toEqual([socket]);
  });

  it('start() assigns a fresh id, activates the session, and clears the buffer', () => {
    const session = new Session();
    session.buffer.append('leftover', 0);
    const previousId = session.id;
    session.start();
    expect(session.id).not.toBe(previousId);
    expect(session.isActive).toBe(true);
    expect(session.buffer.getRecent(0)).toEqual([]);
  });

  it('stop() deactivates the session without clearing the buffer', () => {
    const session = new Session();
    session.start();
    session.buffer.append('kept', 0);
    session.stop();
    expect(session.isActive).toBe(false);
    expect(session.buffer.getRecent(0)).toHaveLength(1);
  });

  it('start() clears any previous sermon cache reference', () => {
    const session = new Session();
    session.sermonCache = { name: 'cachedContents/old' };
    session.start();
    expect(session.sermonCache).toBeNull();
  });

  it('start() replaces the translation cache, discarding anything cached in the previous session', () => {
    const session = new Session();
    session.translationCache.set('zh', 'old-line', '你好');
    session.start();
    expect(session.translationCache.get('zh', 'old-line')).toBeUndefined();
  });

  it('start() replaces the in-flight fill map, discarding anything tracked in the previous session', () => {
    const session = new Session();
    session.inFlightFills.set('zh', Promise.resolve());
    session.start();
    expect(session.inFlightFills.size).toBe(0);
  });
});
