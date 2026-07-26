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

  it('caps concurrent backlog calls at backlogMaxConcurrent', async () => {
    const limiter = new GeminiCallLimiter(3, 1);
    const calls = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started = [false, false, false];

    const runs = calls.map((entry, index) =>
      limiter.run(() => {
        started[index] = true;
        return entry.promise;
      }, 'backlog')
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([true, false, false]); // only 1 backlog runs at a time

    calls[0].resolve('a');
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([true, true, false]); // freed slot admits the next backlog

    calls[1].resolve('b');
    calls[2].resolve('c');
    await Promise.all(runs);
  });

  it('admits a queued live call ahead of a queued backlog call', async () => {
    const limiter = new GeminiCallLimiter(1, 1);
    const first = deferred<string>();
    const queuedLive = deferred<string>();
    let liveStarted = false;
    let backlogStarted = false;

    const runFirst = limiter.run(() => first.promise, 'live'); // occupies the only slot
    await new Promise((resolve) => setImmediate(resolve));

    const runBacklog = limiter.run(() => {
      backlogStarted = true;
      return Promise.resolve('b');
    }, 'backlog');
    const runLive = limiter.run(() => {
      liveStarted = true;
      return queuedLive.promise;
    }, 'live');

    await new Promise((resolve) => setImmediate(resolve));
    expect([liveStarted, backlogStarted]).toEqual([false, false]);

    first.resolve('x');
    await new Promise((resolve) => setImmediate(resolve));
    expect(liveStarted).toBe(true); // live jumps ahead of the queued backlog
    expect(backlogStarted).toBe(false); // slot now held by the queued live call

    queuedLive.resolve('y');
    await new Promise((resolve) => setImmediate(resolve));
    expect(backlogStarted).toBe(true); // backlog runs once a slot frees

    await Promise.all([runFirst, runLive, runBacklog]);
  });

  it('does not starve live: reserves maxConcurrent - backlogMaxConcurrent slots for live', async () => {
    const limiter = new GeminiCallLimiter(3, 1);
    const backlog = deferred<string>();
    const runBacklog = limiter.run(() => backlog.promise, 'backlog'); // holds 1 slot
    await new Promise((resolve) => setImmediate(resolve));

    const live = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started = [false, false, false];
    const liveRuns = live.map((entry, index) =>
      limiter.run(() => {
        started[index] = true;
        return entry.promise;
      }, 'live')
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([true, true, false]); // 2 live run alongside 1 backlog (active = 3 = max)

    backlog.resolve('b');
    live.forEach((entry, index) => entry.resolve(String(index)));
    await Promise.all([runBacklog, ...liveRuns]);
  });

  it('leaves backlog unrestricted when no backlog cap is given (backward compatible)', async () => {
    const limiter = new GeminiCallLimiter(2); // backlogMaxConcurrent defaults to 2
    const first = deferred<string>();
    const second = deferred<string>();
    let firstStarted = false;
    let secondStarted = false;

    const firstRun = limiter.run(() => {
      firstStarted = true;
      return first.promise;
    }, 'backlog');
    const secondRun = limiter.run(() => {
      secondStarted = true;
      return second.promise;
    }, 'backlog');

    await new Promise((resolve) => setImmediate(resolve));
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(true); // both backlog calls run: cap == maxConcurrent == 2

    first.resolve('a');
    second.resolve('b');
    await Promise.all([firstRun, secondRun]);
  });

  it('admits a critical waiter ahead of live waiters already queued', async () => {
    // The transcription check gates every caption in every language; it must
    // never sit behind the translation traffic it shares a limiter with.
    const limiter = new GeminiCallLimiter(1);
    const blocker = deferred<string>();
    const order: string[] = [];

    const blocking = limiter.run(() => {
      order.push('blocker');
      return blocker.promise;
    });
    const live = limiter.run(async () => {
      order.push('live');
    }, 'live');
    const critical = limiter.run(async () => {
      order.push('critical');
    }, 'critical');

    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['blocker']); // both queued behind the single slot

    blocker.resolve('done');
    await Promise.all([blocking, live, critical]);
    expect(order).toEqual(['blocker', 'critical', 'live']);
  });

  it('still admits live ahead of backlog once critical waiters are drained', async () => {
    const limiter = new GeminiCallLimiter(1);
    const blocker = deferred<string>();
    const order: string[] = [];

    const blocking = limiter.run(() => {
      order.push('blocker');
      return blocker.promise;
    });
    const backlog = limiter.run(async () => {
      order.push('backlog');
    }, 'backlog');
    const live = limiter.run(async () => {
      order.push('live');
    }, 'live');
    const critical = limiter.run(async () => {
      order.push('critical');
    }, 'critical');

    await new Promise((resolve) => setImmediate(resolve));
    blocker.resolve('done');
    await Promise.all([blocking, backlog, live, critical]);
    expect(order).toEqual(['blocker', 'critical', 'live', 'backlog']);
  });
});
