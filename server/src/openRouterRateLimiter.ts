import type { CallPriority } from './geminiLimiter.js';

// Smooths bursts of OpenRouter calls into a steady rate so a burst doesn't trip
// OpenRouter's per-minute rate limit. Backlog calls get a lower-priority share:
// they are capped at backlogMaxPerWindow per window and are admitted only after
// live callers, so live captions are never delayed behind on-subscribe backlog
// fills. This is independent of GeminiCallLimiter, which caps concurrency.
export class OpenRouterRateLimiter {
  private readonly startTimes: number[] = []; // all starts in the current window
  private readonly backlogStartTimes: number[] = []; // backlog-only starts in the current window
  private readonly criticalQueue: Array<() => void> = [];
  private readonly liveQueue: Array<() => void> = [];
  private readonly backlogQueue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly maxPerWindow: number = 5,
    private readonly windowMs: number = 2000,
    private readonly backlogMaxPerWindow: number = maxPerWindow
  ) {}

  async run<T>(fn: () => Promise<T>, priority: CallPriority = 'live'): Promise<T> {
    await this.acquire(priority);
    return fn();
  }

  private acquire(priority: CallPriority): Promise<void> {
    return new Promise((resolve) => {
      this.queueFor(priority).push(resolve);
      this.drain();
    });
  }

  private queueFor(priority: CallPriority): Array<() => void> {
    if (priority === 'critical') return this.criticalQueue;
    if (priority === 'backlog') return this.backlogQueue;
    return this.liveQueue;
  }

  private drain(): void {
    const now = Date.now();
    this.prune(now);

    // Critical first — the transcription check gates every caption, so it must
    // never spend the window queued behind translation traffic.
    while (this.criticalQueue.length > 0 && this.startTimes.length < this.maxPerWindow) {
      this.startTimes.push(now);
      this.criticalQueue.shift()!();
    }
    // Then live.
    while (this.liveQueue.length > 0 && this.startTimes.length < this.maxPerWindow) {
      this.startTimes.push(now);
      this.liveQueue.shift()!();
    }
    // Then backlog, bounded by both the total window cap and the backlog sub-cap.
    while (
      this.backlogQueue.length > 0 &&
      this.startTimes.length < this.maxPerWindow &&
      this.backlogStartTimes.length < this.backlogMaxPerWindow
    ) {
      this.startTimes.push(now);
      this.backlogStartTimes.push(now);
      this.backlogQueue.shift()!();
    }

    this.scheduleTimer(now);
  }

  // Recomputes the soonest wake time and rearms the timer accordingly. Always
  // clears any pending timer first: the soonest-needed wake can move earlier
  // than an already-armed deadline (e.g. a live slot freeing before a later
  // backlog sub-window expiry), so we can't just leave an existing timer alone.
  private scheduleTimer(now: number): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const waitMs = this.nextWaitMs(now);
    if (waitMs !== null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, waitMs);
    }
  }

  // Soonest delay (ms) at which a still-blocked waiter could become admissible,
  // or null if nothing is waiting. Wakes and re-evaluates; on wake the drain
  // reschedules if still blocked, so progress is always made.
  private nextWaitMs(now: number): number | null {
    const mainFull = this.startTimes.length >= this.maxPerWindow;
    const candidates: number[] = [];
    // Only meaningful when mainFull (which implies startTimes is non-empty).
    const mainWindowDelay = this.windowMs - (now - this.startTimes[0]);
    if ((this.criticalQueue.length > 0 || this.liveQueue.length > 0) && mainFull) {
      candidates.push(mainWindowDelay);
    }
    if (this.backlogQueue.length > 0) {
      if (mainFull) candidates.push(mainWindowDelay);
      if (this.backlogStartTimes.length >= this.backlogMaxPerWindow && this.backlogStartTimes.length > 0) {
        candidates.push(this.windowMs - (now - this.backlogStartTimes[0]));
      }
    }
    if (candidates.length === 0) return null;
    return Math.max(0, Math.min(...candidates)) + 1;
  }

  private prune(now: number): void {
    while (this.startTimes.length > 0 && now - this.startTimes[0] >= this.windowMs) {
      this.startTimes.shift();
    }
    while (this.backlogStartTimes.length > 0 && now - this.backlogStartTimes[0] >= this.windowMs) {
      this.backlogStartTimes.shift();
    }
  }
}
