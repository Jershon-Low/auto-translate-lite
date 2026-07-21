import { describe, it, expect } from 'vitest';
import { createLogHub, type LogEntry } from '../src/logHub';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return { timestamp: new Date().toISOString(), level: 'info', event: 'test', ...overrides };
}

describe('logHub', () => {
  it('keeps only the most recent entries up to the buffer size, in order', () => {
    const hub = createLogHub(2);
    hub.push(entry({ event: 'a' }));
    hub.push(entry({ event: 'b' }));
    hub.push(entry({ event: 'c' }));
    expect(hub.getHistory().map((e) => e.event)).toEqual(['b', 'c']);
  });

  it('getHistory returns a copy, not the internal buffer', () => {
    const hub = createLogHub();
    hub.push(entry({ event: 'a' }));
    const history = hub.getHistory();
    history.push(entry({ event: 'mutated' }));
    expect(hub.getHistory().map((e) => e.event)).toEqual(['a']);
  });

  it('delivers newly pushed entries to subscribers', () => {
    const hub = createLogHub();
    const received: string[] = [];
    hub.subscribe((e) => received.push(String(e.event)));
    hub.push(entry({ event: 'live' }));
    expect(received).toEqual(['live']);
  });

  it('unsubscribe stops further delivery', () => {
    const hub = createLogHub();
    const received: string[] = [];
    const unsubscribe = hub.subscribe((e) => received.push(String(e.event)));
    unsubscribe();
    hub.push(entry({ event: 'after' }));
    expect(received).toEqual([]);
  });

  it('a throwing subscriber does not break push or other subscribers', () => {
    const hub = createLogHub();
    const received: string[] = [];
    hub.subscribe(() => {
      throw new Error('bad subscriber');
    });
    hub.subscribe((e) => received.push(String(e.event)));
    expect(() => hub.push(entry({ event: 'ok' }))).not.toThrow();
    expect(received).toEqual(['ok']);
  });
});
