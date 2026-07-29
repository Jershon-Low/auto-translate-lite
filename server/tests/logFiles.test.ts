import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogFileStore, melbourneStamp, GRACE_MS } from '../src/logFiles';

let dir: string;

beforeEach(async () => {
  delete process.env.LOG_FILE_PATH;
  dir = await mkdtemp(join(tmpdir(), 'logfiles-test-'));
});

afterEach(async () => {
  delete process.env.LOG_FILE_PATH;
  await rm(dir, { recursive: true, force: true });
});

function store() {
  return createLogFileStore(dir, join(dir, 'events.log'));
}

describe('melbourneStamp', () => {
  it('renders an AEST instant with a +1000 offset', () => {
    // 2026-07-26T05:27:05Z is 3:27 PM in Melbourne, winter (AEST, UTC+10).
    expect(melbourneStamp(Date.parse('2026-07-26T05:27:05.418Z'))).toBe('2026-07-26T15-27+1000');
  });

  it('renders an AEDT instant with a +1100 offset', () => {
    // 2026-01-15T05:00:00Z is 4:00 PM in Melbourne, summer (AEDT, UTC+11).
    expect(melbourneStamp(Date.parse('2026-01-15T05:00:00.000Z'))).toBe('2026-01-15T16-00+1100');
  });

  it('renders midnight as hour 00, not 24', () => {
    // 2026-07-25T14:00:00Z is exactly midnight in Melbourne.
    expect(melbourneStamp(Date.parse('2026-07-25T14:00:00.000Z'))).toBe('2026-07-26T00-00+1000');
  });
});

describe('current file resolution', () => {
  it('writes to server.log before any session has started', () => {
    expect(store().currentPath()).toBe(join(dir, 'server.log'));
  });

  it('writes to a session file named for the start instant once a session opens', () => {
    const s = store();
    s.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('keeps writing to the session file during the grace window after a stop', () => {
    const s = store();
    const start = Date.parse('2026-07-26T05:27:05.418Z');
    s.openSession(start);
    s.closeSession(start + 60_000);
    // A disconnect diagnostic logged 30s after the stop belongs to that service.
    expect(s.currentPath(start + 60_000 + 30_000)).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('falls back to server.log once the grace window has elapsed', async () => {
    const s = store();
    const start = Date.now() - GRACE_MS * 3;
    s.openSession(start);
    s.closeSession(start + 1000);
    expect(s.currentPath()).toBe(join(dir, 'server.log'));
  });

  it('resumes the same file when a reconnect lands inside the grace window', () => {
    const s = store();
    const start = Date.parse('2026-07-26T05:27:05.418Z');
    s.openSession(start);
    s.closeSession(start + 60_000);
    s.openSession(start + 120_000);
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('starts a new file when the next session is past the grace window', () => {
    const s = store();
    const start = Date.parse('2026-07-26T05:27:05.418Z');
    s.openSession(start);
    s.closeSession(start + 60_000);
    s.openSession(start + 60_000 + GRACE_MS + 1);
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-33+1000.log'));
  });

  it('is a no-op when openSession is called twice without a stop', () => {
    // The double-start bug fires session.start() twice; it must not rotate mid-service.
    const s = store();
    const start = Date.parse('2026-07-26T05:27:05.418Z');
    s.openSession(start);
    s.openSession(start + 12_000);
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('is a no-op when closeSession is called twice', () => {
    // session.stop() fires from both the 'stop' message and the socket close handler.
    const s = store();
    const start = Date.now();
    s.openSession(start);
    s.closeSession(start + 1000);
    s.closeSession(start + 2000);
    expect(s.activeName()).toBeNull();
    expect(s.currentPath()).toBe(join(dir, melbourneSessionName(start)));
  });

  it('reports the running session as active, and nothing once it stops', () => {
    const s = store();
    const start = Date.parse('2026-07-26T05:27:05.418Z');
    s.openSession(start);
    expect(s.activeName()).toBe('session-2026-07-26T15-27+1000.log');
    s.closeSession(start + 1000);
    expect(s.activeName()).toBeNull();
  });

  it('suffixes a colliding filename rather than appending to the wrong session', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), '');
    const s = store();
    s.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000-2.log'));
  });
});

describe('LOG_FILE_PATH override', () => {
  it('returns the override and never rotates', () => {
    process.env.LOG_FILE_PATH = '/tmp/pinned.log';
    const s = store();
    s.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    expect(s.currentPath()).toBe('/tmp/pinned.log');
    expect(s.activeName()).toBeNull();
  });
});

function melbourneSessionName(ms: number): string {
  return `session-${melbourneStamp(ms)}.log`;
}
