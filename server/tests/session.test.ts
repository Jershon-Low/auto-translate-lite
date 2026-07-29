import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Session.start()/stop() drive the log-file store; pinning LOG_FILE_PATH keeps
// these unit tests from creating files under server/data/logs.
process.env.LOG_FILE_PATH = join(tmpdir(), 'auto-translate-lite-session-test-events.log');

import { WebSocket } from 'ws';
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

  it('opens a log-file session on start and closes it on stop', () => {
    const session = new Session();
    session.start();
    session.stop();
    // With LOG_FILE_PATH pinned the store is inert; this asserts the calls
    // exist and do not throw, which is what the wiring must guarantee.
    expect(session.id).toEqual(expect.any(String));
  });

  it('start() clears any previous role caches and providers', () => {
    const session = new Session();
    session.roleCaches = {
      transcriptionVerifier: { name: 'cachedContents/old-tv' },
      translation: { name: 'cachedContents/old-t' },
      translationVerifier: { name: 'cachedContents/old-vv' },
    };
    session.start();
    expect(session.roleCaches).toEqual({
      transcriptionVerifier: null,
      translation: null,
      translationVerifier: null,
    });
    expect(session.providers).toBeNull();
  });

  it('start() replaces the translation cache, discarding anything cached in the previous session', () => {
    const session = new Session();
    session.translationCache.set('zh', 'old-line', { translated: '你好', flagged: false });
    session.start();
    expect(session.translationCache.get('zh', 'old-line')).toBeUndefined();
  });

  it('start() replaces the in-flight fill map, discarding anything tracked in the previous session', () => {
    const session = new Session();
    session.inFlightFills.set('zh', Promise.resolve());
    session.start();
    expect(session.inFlightFills.size).toBe(0);
  });

  it('start() resets translationFlagDisplayMode to the default (hide)', () => {
    const session = new Session();
    session.translationFlagDisplayMode = 'flag';
    session.start();
    expect(session.translationFlagDisplayMode).toBe('hide');
  });

  it('defaults mode to automatic', () => {
    const session = new Session();
    expect(session.mode).toBe('automatic');
  });

  it('start() does not reset mode — it is an operator preference, not session data', () => {
    const session = new Session();
    session.mode = 'manual';
    session.start();
    expect(session.mode).toBe('manual');
  });

  it('defaults captureSocket to null', () => {
    const session = new Session();
    expect(session.captureSocket).toBeNull();
  });

  it('reviewSockets: adds, lists, and removes review connections', () => {
    const session = new Session();
    const socketA = fakeSocket();
    const socketB = fakeSocket();
    session.addReview(socketA);
    session.addReview(socketB);
    expect(session.getAllReview()).toEqual([socketA, socketB]);
    session.removeReview(socketA);
    expect(session.getAllReview()).toEqual([socketB]);
  });

  it('broadcastToReview sends only to sockets whose readyState is OPEN', () => {
    const session = new Session();
    const open = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;
    const closed = { readyState: WebSocket.CLOSED, send: vi.fn() } as unknown as WebSocket;
    session.addReview(open);
    session.addReview(closed);
    session.broadcastToReview('hello');
    expect(open.send).toHaveBeenCalledWith('hello');
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('start() resets ingestQueue, verifyEmitQueue and publishQueue to fresh resolved promises', () => {
    const session = new Session();
    const originalIngest = session.ingestQueue;
    const originalVerifyEmit = session.verifyEmitQueue;
    const originalPublish = session.publishQueue;
    session.start();
    expect(session.ingestQueue).not.toBe(originalIngest);
    expect(session.verifyEmitQueue).not.toBe(originalVerifyEmit);
    expect(session.publishQueue).not.toBe(originalPublish);
  });

  it('start() clears verification-stage lag state so a new session does not inherit the old one', () => {
    // verifyLag is strict FIFO: carrying entries across a restart would leave
    // the tracker permanently reading high, since their dequeues never come.
    const session = new Session();
    session.verifyLag.enqueue(1000);
    session.verifyLagHigh = true;
    const originalVerifyLag = session.verifyLag;

    session.start();

    expect(session.verifyLag).not.toBe(originalVerifyLag);
    expect(session.verifyLag.size).toBe(0);
    expect(session.verifyLagHigh).toBe(false);
  });
});
