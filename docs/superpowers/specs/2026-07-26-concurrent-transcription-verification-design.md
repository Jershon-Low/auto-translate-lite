# Concurrent transcription verification

Status: implemented, 2026-07-26.

## The failure this fixes

Session of 2026-07-25 23:29 → 02:58 UTC, 2862 final segments. From ~02:19 the
captions fell steadily further behind and never recovered; by the end the
pipeline was 6.4 minutes behind the speaker and still draining after the audio
stopped. The viewer, capture and review pages were all affected equally.

Measured from `events.log`, by matching `transcription_flagged` timestamps back
to the `dg_diag_transcript` that produced them:

| session minute | segment arrival → verdict |
|---|---|
| 0–162 | 1.5–2.1s (flat) |
| 171 | 30s |
| 181 | 114s |
| 195 | 289s |
| 205 | 381s |

`ingest_lag_high` fired at 02:19:05 and never cleared — it is edge-triggered, so
ingest wait stayed above 8s for the final 39 minutes on a single log line.

### Cause

`handleFinalSegmentFast` awaited the transcription check, and every segment ran
through it on one serial promise chain (`session.ingestQueue`). The check was
therefore the pipeline's service rate, with no concurrency. Two things crossed
over at once:

- The speaker got denser: median inter-segment gap 3.60s → 2.40s.
- The check got slower: ~1.6s → ~2.9s (inferred from backlog growth rate),
  because translation had become active around minute 120 and all three LLM
  roles shared one concurrency limiter (8) and one rate limiter (5 per 2s).
  Translation runs `reasoning: "high"` — the slowest role — and the cheap check
  every caption depends on was queuing behind it.

Once service time exceeded arrival interval by ~0.5s/segment at ~22
segments/min, the queue grew ~10s per minute with no mechanism to drain.

The existing publish-path back-pressure (`MAX_PUBLISH_LAG_MS`,
`caption_lag_shed`) could not help: it sits *downstream* of the ingest queue. It
fired 590 times during the session while the real backlog kept growing.

### Why the logs looked healthy

`dg_diag_transcript` is written in `deepgram.ts` when the segment arrives —
upstream of the check. The `transcript` and `caption-pending` broadcasts are
both downstream of it. So the log showed English arriving on time while no
client had been told anything.

## Design

Split ingest into two phases.

**Phase A — `beginSegment`.** Runs on `session.ingestQueue`, contains no awaits,
so the queue stays drained. It reserves the line's ordered slot
(`TranscriptBuffer.reserve`, marking it `unverified`), computes preceding
context anchored on that slot, and starts the check without waiting for it.

Reserving *before* the check is what makes concurrency safe: arrival order is
fixed by the reservation, so the checks themselves may finish in any order.

**Phase B — `emitSegment`.** Chained on `session.verifyEmitQueue`, a second
ordered chain. Awaits this segment's check, applies the verdict
(`TranscriptBuffer.applyVerdict`) and publishes. Because the chain is ordered,
every client-visible effect still lands in arrival order — the same guarantee
the serial version gave, without the head-of-line blocking.

### Bound on a hung check — `raceVerifyAgainstDeadline`

Concurrency fixes throughput but not a check that hangs outright: it is already
in flight, and everything behind it on the emit chain waits. Each segment's wait
is therefore capped at `maxPublishLagMs` from its own arrival. On expiry the
line publishes **unchecked**, logged as `transcription_verify_timeout`.

Deliberate choices:

- **Publish unchecked rather than drop.** The checker being unavailable is not a
  reason to leave viewers dark, and it matches how `raceAgainstDeadline` treats
  a stalled translation.
- **Ignore a late verdict rather than retract.** The line is on screen and being
  read; pulling it back is worse than the ~3% chance it was mis-transcribed.
- **No shed valve.** An earlier draft skipped the call entirely while the stage
  was behind. It was removed: the deadline already bounds lag, and shedding
  would also stop us discovering that the checker had recovered. Letting every
  segment issue its call and time out keeps probing and self-heals.

### Limiter tiers

`CallPriority` gains `'critical'`, admitted ahead of `'live'` in both
`GeminiCallLimiter` and `OpenRouterRateLimiter`. Only the transcription-verifier
role uses it (`criticalLlmClients`, optional — falls back to `llmClients`). One
cheap call that every caption in every language is blocked behind should not
queue behind translation.

## Trade-offs accepted

**Context may cite a line that is later flagged.** A segment's preceding context
is computed at reserve time, when earlier lines may still be unverified. The
serial version excluded flagged lines. Context is advisory, the flag rate is a
few percent, and the alternative was falling minutes behind.

**Unverified lines occupy a buffer slot.** They are excluded from both backlog
snapshots (viewer and review) — they have never been broadcast and may yet be
flagged. They reach a joining client as a normal `transcript`/`caption` once
their check lands.

**Reinstate is not ordered against in-flight segments.** `handleReinstateFast`
broadcasts directly rather than through `verifyEmitQueue`, so a reinstated line
can appear before an earlier segment still awaiting its check. It is an explicit
operator action rather than stream order, and the line keeps its original buffer
position.

## Observability

- `verify_lag_high` / `verify_lag_cleared` — edge-triggered, the age of the
  oldest segment yet to clear the check. **This is the metric that would have
  caught the original bug**; watch it, not `ingest_lag_high`.
- `ingest_lag_high` / `ingest_lag_cleared` — now expected to sit near zero;
  non-zero means phase A itself is blocked.
- `transcription_verify_timeout` — a check exceeded its deadline and the line
  published unchecked.
