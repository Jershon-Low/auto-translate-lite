import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterRateLimiter } from '../src/openRouterRateLimiter';

describe('OpenRouterRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs up to maxPerWindow calls immediately', async () => {
    const limiter = new OpenRouterRateLimiter(3, 2000);
    const started: boolean[] = [false, false, false];

    const runs = started.map((_, index) =>
      limiter.run(async () => {
        started[index] = true;
        return index;
      })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([true, true, true]);
    await Promise.all(runs);
  });

  it('defers calls beyond maxPerWindow until the window rolls over', async () => {
    const limiter = new OpenRouterRateLimiter(2, 2000);
    const started: boolean[] = [false, false, false];

    const runs = started.map((_, index) =>
      limiter.run(async () => {
        started[index] = true;
        return index;
      })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([true, true, false]);

    await vi.advanceTimersByTimeAsync(2001);
    expect(started).toEqual([true, true, true]);

    await Promise.all(runs);
  });

  it('spreads a burst across multiple windows at the configured rate', async () => {
    const limiter = new OpenRouterRateLimiter(1, 500);
    const order: number[] = [];

    const runs = [0, 1, 2].map((index) =>
      limiter.run(async () => {
        order.push(index);
        return index;
      })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([0]);

    await vi.advanceTimersByTimeAsync(501);
    expect(order).toEqual([0, 1]);

    await vi.advanceTimersByTimeAsync(501);
    expect(order).toEqual([0, 1, 2]);

    await Promise.all(runs);
  });

  it('caps backlog admissions at backlogMaxPerWindow even when the main window has room', async () => {
    const limiter = new OpenRouterRateLimiter(5, 2000, 1);
    const started = [false, false, false];

    const runs = started.map((_, index) =>
      limiter.run(async () => {
        started[index] = true;
        return index;
      }, 'backlog')
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([true, false, false]); // 1 backlog/window despite 5 total slots

    await vi.advanceTimersByTimeAsync(2001);
    expect(started).toEqual([true, true, false]);

    await vi.advanceTimersByTimeAsync(2001);
    expect(started).toEqual([true, true, true]);

    await Promise.all(runs);
  });

  it('admits a queued live call ahead of a queued backlog call', async () => {
    const limiter = new OpenRouterRateLimiter(1, 2000, 1);
    const order: string[] = [];

    const runLive0 = limiter.run(async () => {
      order.push('l0');
    }, 'live'); // fills the single-slot window
    const runBacklog = limiter.run(async () => {
      order.push('b');
    }, 'backlog'); // queued
    const runLive1 = limiter.run(async () => {
      order.push('l1');
    }, 'live'); // queued

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['l0']);

    await vi.advanceTimersByTimeAsync(2001);
    expect(order).toEqual(['l0', 'l1']); // queued live drains before queued backlog

    await vi.advanceTimersByTimeAsync(2001);
    expect(order).toEqual(['l0', 'l1', 'b']);

    await Promise.all([runLive0, runBacklog, runLive1]);
  });

  it('reserves maxPerWindow - backlogMaxPerWindow tokens for live under backlog pressure', async () => {
    const limiter = new OpenRouterRateLimiter(3, 2000, 1);
    const started = { b0: false, b1: false, l0: false, l1: false, l2: false };

    const runs = [
      limiter.run(async () => {
        started.b0 = true;
      }, 'backlog'),
      limiter.run(async () => {
        started.b1 = true;
      }, 'backlog'),
      limiter.run(async () => {
        started.l0 = true;
      }, 'live'),
      limiter.run(async () => {
        started.l1 = true;
      }, 'live'),
      limiter.run(async () => {
        started.l2 = true;
      }, 'live'),
    ];

    await vi.advanceTimersByTimeAsync(0);
    // Window of 3: 1 backlog (its cap) + 2 live (the reserved 3 - 1). Aggregate == 3 == max.
    expect(started).toEqual({ b0: true, b1: false, l0: true, l1: true, l2: false });

    await vi.advanceTimersByTimeAsync(2001);
    expect(started).toEqual({ b0: true, b1: true, l0: true, l1: true, l2: true });

    await Promise.all(runs);
  });
});
