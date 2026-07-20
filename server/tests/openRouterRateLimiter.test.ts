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
});
