// Smooths bursts of OpenRouter calls (e.g. several viewers switching to a new
// language at once, each triggering a backlog-translate + verify call, on top
// of the ongoing live per-segment translation) into a steady rate, so a burst
// doesn't trip OpenRouter's own per-minute rate limit. This is independent of
// GeminiCallLimiter, which only caps concurrency — it does not pace requests
// over time, and is shared with the unrelated Gemini call path.
export class OpenRouterRateLimiter {
  private readonly startTimes: number[] = [];
  private readonly queue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly maxPerWindow: number = 5,
    private readonly windowMs: number = 2000
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  private drain(): void {
    const now = Date.now();
    this.prune(now);
    while (this.queue.length > 0 && this.startTimes.length < this.maxPerWindow) {
      this.startTimes.push(now);
      const resolve = this.queue.shift()!;
      resolve();
    }
    if (this.queue.length > 0 && this.timer === null) {
      const oldest = this.startTimes[0];
      const waitMs = Math.max(0, this.windowMs - (now - oldest)) + 1;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, waitMs);
    }
  }

  private prune(now: number): void {
    while (this.startTimes.length > 0 && now - this.startTimes[0] >= this.windowMs) {
      this.startTimes.shift();
    }
  }
}
