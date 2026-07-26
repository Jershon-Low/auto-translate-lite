// 'critical' is the transcription check: one cheap call that every caption —
// in every language — is blocked behind, so it is admitted ahead of the
// translation traffic it would otherwise queue behind. 'backlog' is
// on-subscribe backfill, admitted last.
export type CallPriority = 'critical' | 'live' | 'backlog';

export class GeminiCallLimiter {
  private active = 0;
  private backlogActive = 0;
  private readonly criticalQueue: Array<() => void> = [];
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
      this.queueFor(priority).push(resolve);
      this.drain();
    });
  }

  private queueFor(priority: CallPriority): Array<() => void> {
    if (priority === 'critical') return this.criticalQueue;
    if (priority === 'backlog') return this.backlogQueue;
    return this.liveQueue;
  }

  // Strict tiers: critical drains before live, live before backlog. Backlog
  // waiters are additionally capped at backlogMaxConcurrent, so at least
  // maxConcurrent - backlogMaxConcurrent slots are never occupiable by backlog.
  private drain(): void {
    while (this.criticalQueue.length > 0 && this.active < this.maxConcurrent) {
      this.active += 1;
      this.criticalQueue.shift()!();
    }
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
