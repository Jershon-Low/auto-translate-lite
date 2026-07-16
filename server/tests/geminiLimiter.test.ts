import { describe, it, expect } from 'vitest';
import { GeminiCallLimiter } from '../src/geminiLimiter';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('GeminiCallLimiter', () => {
  it('runs up to maxConcurrent calls immediately, without waiting for a slot', async () => {
    const limiter = new GeminiCallLimiter(2);
    const first = deferred<string>();
    const second = deferred<string>();
    let firstStarted = false;
    let secondStarted = false;

    const firstRun = limiter.run(() => {
      firstStarted = true;
      return first.promise;
    });
    const secondRun = limiter.run(() => {
      secondStarted = true;
      return second.promise;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(true);

    first.resolve('a');
    second.resolve('b');
    await Promise.all([firstRun, secondRun]);
  });

  it('queues the (maxConcurrent + 1)th call until a slot frees', async () => {
    const limiter = new GeminiCallLimiter(2);
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    let thirdStarted = false;

    const firstRun = limiter.run(() => first.promise);
    const secondRun = limiter.run(() => second.promise);
    const thirdRun = limiter.run(() => {
      thirdStarted = true;
      return third.promise;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(thirdStarted).toBe(false);

    first.resolve('a');
    await new Promise((resolve) => setImmediate(resolve));
    expect(thirdStarted).toBe(true);

    second.resolve('b');
    third.resolve('c');
    await Promise.all([firstRun, secondRun, thirdRun]);
  });

  it('frees the slot for the next queued call even if the running call rejects', async () => {
    const limiter = new GeminiCallLimiter(1);
    const first = deferred<string>();
    let secondStarted = false;

    const firstRun = limiter.run(() => first.promise).catch(() => 'handled-first-rejection');
    const secondRun = limiter.run(() => {
      secondStarted = true;
      return Promise.resolve('b');
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(secondStarted).toBe(false);

    first.reject(new Error('boom'));
    await firstRun;
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondStarted).toBe(true);

    await secondRun;
  });

  it('defaults maxConcurrent to 8', async () => {
    const limiter = new GeminiCallLimiter();
    const deferredCalls = Array.from({ length: 8 }, () => deferred<number>());
    const started: boolean[] = new Array(8).fill(false);

    const runs = deferredCalls.map((entry, index) =>
      limiter.run(() => {
        started[index] = true;
        return entry.promise;
      })
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(started.every(Boolean)).toBe(true);

    deferredCalls.forEach((entry, index) => entry.resolve(index));
    await Promise.all(runs);
  });
});
