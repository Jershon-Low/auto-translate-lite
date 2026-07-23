export type CallPriority = 'live' | 'backlog';

export class GeminiCallLimiter {
  private active = 0;
  private backlogActive = 0;
  private readonly liveQueue: Array<() => void> = [];
  private readonly backlogQueue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number = 8,
    private readonly backlogMaxConcurrent: number = maxConcurrent
  ) {}

  async run<T>(fn: () => Promise<T>, priority: CallPriority = 'live'): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release(priority);
    }
  }

  private acquire(priority: CallPriority): Promise<void> {
    return new Promise((resolve) => {
      (priority === 'backlog' ? this.backlogQueue : this.liveQueue).push(resolve);
      this.drain();
    });
  }

  // Live waiters are admitted first (priority); backlog waiters are admitted
  // only up to backlogMaxConcurrent, so at least maxConcurrent - backlogMaxConcurrent
  // slots are never occupiable by backlog.
  private drain(): void {
    while (this.liveQueue.length > 0 && this.active < this.maxConcurrent) {
      this.active += 1;
      this.liveQueue.shift()!();
    }
    while (
      this.backlogQueue.length > 0 &&
      this.active < this.maxConcurrent &&
      this.backlogActive < this.backlogMaxConcurrent
    ) {
      this.active += 1;
      this.backlogActive += 1;
      this.backlogQueue.shift()!();
    }
  }

  private release(priority: CallPriority): void {
    this.active -= 1;
    if (priority === 'backlog') this.backlogActive -= 1;
    this.drain();
  }
}
