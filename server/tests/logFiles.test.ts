import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

import { stat } from 'node:fs/promises';

function entryLine(timestamp: string, event: string): string {
  return JSON.stringify({ timestamp, level: 'info', event }) + '\n';
}

describe('list', () => {
  it('returns an empty array when the directory does not exist', async () => {
    const s = createLogFileStore(join(dir, 'missing'), join(dir, 'nope.log'));
    expect(await s.list()).toEqual([]);
  });

  it('reports start and end from the first and last entries', async () => {
    await writeFile(
      join(dir, 'session-2026-07-26T15-27+1000.log'),
      entryLine('2026-07-26T05:27:05.418Z', 'dg_diag_open') +
        entryLine('2026-07-26T06:00:00.000Z', 'caption_corrected') +
        entryLine('2026-07-26T07:07:45.006Z', 'dg_diag_close')
    );
    const [file] = await store().list();
    expect(file.name).toBe('session-2026-07-26T15-27+1000.log');
    expect(file.kind).toBe('session');
    expect(file.startedAt).toBe('2026-07-26T05:27:05.418Z');
    expect(file.endedAt).toBe('2026-07-26T07:07:45.006Z');
    expect(file.bytes).toBe((await stat(join(dir, 'session-2026-07-26T15-27+1000.log'))).size);
    expect(file.active).toBe(false);
  });

  it('reports a single-entry file with equal start and end', async () => {
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), entryLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    const [file] = await store().list();
    expect(file.startedAt).toBe('2026-07-26T05:27:05.418Z');
    expect(file.endedAt).toBe('2026-07-26T05:27:05.418Z');
  });

  it('reports an empty file with null timestamps rather than failing the listing', async () => {
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), '');
    const [file] = await store().list();
    expect(file.startedAt).toBeNull();
    expect(file.endedAt).toBeNull();
    expect(file.bytes).toBe(0);
  });

  it('sorts newest first, with unknown-start files last', async () => {
    await writeFile(join(dir, 'session-2026-07-25T09-00+1000.log'), entryLine('2026-07-24T23:00:00.000Z', 'dg_diag_open'));
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), entryLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    await writeFile(join(dir, 'session-2026-07-27T09-42+1000.log'), '');
    const names = (await store().list()).map((file) => file.name);
    expect(names).toEqual([
      'session-2026-07-26T15-27+1000.log',
      'session-2026-07-25T09-00+1000.log',
      'session-2026-07-27T09-42+1000.log',
    ]);
  });

  it('includes server.log and the legacy file with their own kinds', async () => {
    await writeFile(join(dir, 'server.log'), entryLine('2026-07-27T01:00:00.000Z', 'cost_file_load_failed'));
    await writeFile(join(dir, 'events.log'), entryLine('2026-07-18T00:00:00.000Z', 'dg_diag_open'));
    const kinds = Object.fromEntries((await store().list()).map((file) => [file.name, file.kind]));
    expect(kinds).toEqual({ 'server.log': 'server', 'events.log': 'legacy' });
  });

  it('omits the legacy file when it does not exist', async () => {
    await writeFile(join(dir, 'server.log'), entryLine('2026-07-27T01:00:00.000Z', 'x'));
    expect((await store().list()).map((file) => file.name)).toEqual(['server.log']);
  });

  it('marks only the running session as active', async () => {
    const s = store();
    s.openSession(Date.parse('2026-07-26T05:27:05.418Z'));
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), entryLine('2026-07-26T05:27:05.418Z', 'dg_diag_open'));
    await writeFile(join(dir, 'session-2026-07-25T09-00+1000.log'), entryLine('2026-07-24T23:00:00.000Z', 'dg_diag_open'));
    const active = Object.fromEntries((await s.list()).map((file) => [file.name, file.active]));
    expect(active).toEqual({
      'session-2026-07-26T15-27+1000.log': true,
      'session-2026-07-25T09-00+1000.log': false,
    });
  });
});

describe('initFromDisk', () => {
  it('resumes the newest session file when its last entry is inside the grace window', async () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    await writeFile(
      join(dir, 'session-2026-07-26T15-27+1000.log'),
      JSON.stringify({ timestamp: recent, level: 'info', event: 'dg_diag_open' }) + '\n'
    );
    const s = store();
    await s.initFromDisk();
    // A pm2 restart mid-service must keep writing to the same file.
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('does not resume a session whose last entry is older than the grace window', async () => {
    const old = new Date(Date.now() - GRACE_MS * 4).toISOString();
    await writeFile(
      join(dir, 'session-2026-07-26T15-27+1000.log'),
      JSON.stringify({ timestamp: old, level: 'info', event: 'dg_diag_close' }) + '\n'
    );
    const s = store();
    await s.initFromDisk();
    expect(s.currentPath()).toBe(join(dir, 'server.log'));
  });

  it('picks the newest of several session files', async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    const old = new Date(Date.now() - GRACE_MS * 10).toISOString();
    await writeFile(join(dir, 'session-2026-07-25T09-00+1000.log'), JSON.stringify({ timestamp: old, level: 'info' }) + '\n');
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), JSON.stringify({ timestamp: recent, level: 'info' }) + '\n');
    const s = store();
    await s.initFromDisk();
    expect(s.currentPath()).toBe(join(dir, 'session-2026-07-26T15-27+1000.log'));
  });

  it('treats a corrupt tail as no resumable session', async () => {
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), '{"timestamp":"2026-07-2\n');
    const s = store();
    await s.initFromDisk();
    expect(s.currentPath()).toBe(join(dir, 'server.log'));
  });

  it('treats an empty session file as no resumable session', async () => {
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), '');
    const s = store();
    await s.initFromDisk();
    expect(s.currentPath()).toBe(join(dir, 'server.log'));
  });

  it('does nothing when the log directory does not exist yet', async () => {
    const s = createLogFileStore(join(dir, 'missing'), join(dir, 'events.log'));
    await expect(s.initFromDisk()).resolves.toBeUndefined();
    expect(s.currentPath()).toBe(join(dir, 'missing', 'server.log'));
  });

  it('does nothing when LOG_FILE_PATH is set', async () => {
    const recent = new Date().toISOString();
    await writeFile(join(dir, 'session-2026-07-26T15-27+1000.log'), JSON.stringify({ timestamp: recent, level: 'info' }) + '\n');
    process.env.LOG_FILE_PATH = '/tmp/pinned.log';
    const s = store();
    await s.initFromDisk();
    expect(s.currentPath()).toBe('/tmp/pinned.log');
  });
});
