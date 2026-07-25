import { describe, it, expect } from 'vitest';
import { LiveLagTracker } from '../src/liveLag';

describe('LiveLagTracker', () => {
  it('reports zero lag when empty', () => {
    const tracker = new LiveLagTracker();
    expect(tracker.lagMs(1000)).toBe(0);
    expect(tracker.size).toBe(0);
  });

  it('reports the age of the single pending entry', () => {
    const tracker = new LiveLagTracker();
    tracker.enqueue(1000);
    expect(tracker.lagMs(6000)).toBe(5000);
    expect(tracker.size).toBe(1);
  });

  it('tracks the oldest entry as the head, FIFO', () => {
    const tracker = new LiveLagTracker();
    tracker.enqueue(1000);
    tracker.enqueue(3000);
    // Oldest (1000) drives lag.
    expect(tracker.lagMs(4000)).toBe(3000);
    tracker.dequeue();
    // Now the head is 3000.
    expect(tracker.lagMs(4000)).toBe(1000);
    expect(tracker.size).toBe(1);
  });

  it('returns to zero lag once fully drained', () => {
    const tracker = new LiveLagTracker();
    tracker.enqueue(1000);
    tracker.dequeue();
    expect(tracker.lagMs(9000)).toBe(0);
    expect(tracker.size).toBe(0);
  });

  it('never reports negative lag if the clock reference precedes the entry', () => {
    const tracker = new LiveLagTracker();
    tracker.enqueue(5000);
    expect(tracker.lagMs(4000)).toBe(0);
  });
});
