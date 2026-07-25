// Tracks how long the oldest not-yet-published line has waited in the live
// publish path, so the pipeline can measure — and shed against — its own lag.
// A strict FIFO: lines enter (enqueue) in spoken order and leave (dequeue) in
// the same order publishQueue sends them, so the head is always the oldest
// un-published line. See
// docs/superpowers/specs/2026-07-23-live-queue-backpressure-design.md.
export class LiveLagTracker {
  private pending: number[] = [];

  enqueue(atMs: number): void {
    this.pending.push(atMs);
  }

  dequeue(): void {
    this.pending.shift();
  }

  // Age of the oldest still-pending line, or 0 when the publish path is empty.
  lagMs(nowMs: number): number {
    if (this.pending.length === 0) return 0;
    return Math.max(0, nowMs - this.pending[0]);
  }

  get size(): number {
    return this.pending.length;
  }
}
