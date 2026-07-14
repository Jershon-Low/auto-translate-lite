import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCostTracker } from '../src/costTracker';

describe('createCostTracker', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('starts at zero for both session and lifetime when no file exists yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));
    expect(tracker.getSessionCostUsd()).toBe(0);
    expect(tracker.getLifetimeCostUsd()).toBe(0);
  });

  it('loads a prior lifetime total from an existing file', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const filePath = join(tempDir, 'cost.json');
    await writeFile(filePath, JSON.stringify({ lifetimeUsd: 12.5 }), 'utf-8');
    const tracker = createCostTracker(filePath);
    expect(tracker.getLifetimeCostUsd()).toBe(12.5);
    expect(tracker.getSessionCostUsd()).toBe(0);
  });

  it('treats a corrupt file as a zero starting balance', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const filePath = join(tempDir, 'cost.json');
    await writeFile(filePath, 'not json', 'utf-8');
    const tracker = createCostTracker(filePath);
    expect(tracker.getLifetimeCostUsd()).toBe(0);
  });

  it('charges non-cached input at the standard rate, cached input at the discounted rate, and candidates at the output rate', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    // 1,000,000 prompt tokens, 200,000 of which came from cache; 100,000 candidate tokens.
    tracker.recordGeminiUsage({ promptTokens: 1_000_000, candidatesTokens: 100_000, cachedTokens: 200_000 });

    // 800k non-cached @ $0.25/1M = $0.20; 200k cached @ $0.025/1M = $0.005; 100k output @ $1.50/1M = $0.15
    expect(tracker.getSessionCostUsd()).toBeCloseTo(0.355, 6);
    expect(tracker.getLifetimeCostUsd()).toBeCloseTo(0.355, 6);
  });

  it('charges Deepgram usage at the per-minute rate', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    tracker.recordDeepgramSeconds(60);

    expect(tracker.getSessionCostUsd()).toBeCloseTo(0.0077, 6);
  });

  it('resets only the session total, leaving the lifetime total untouched', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    tracker.recordDeepgramSeconds(60);
    tracker.resetSession();

    expect(tracker.getSessionCostUsd()).toBe(0);
    expect(tracker.getLifetimeCostUsd()).toBeCloseTo(0.0077, 6);
  });

  it('does not notify subscribers on resetSession', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    const calls: Array<[number, number]> = [];
    tracker.onUpdate((sessionUsd, lifetimeUsd) => calls.push([sessionUsd, lifetimeUsd]));

    tracker.resetSession();

    expect(calls).toHaveLength(0);
  });

  it('persists the running lifetime total to disk synchronously after every update', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const filePath = join(tempDir, 'cost.json');
    const tracker = createCostTracker(filePath);

    tracker.recordDeepgramSeconds(60);

    const saved = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(saved.lifetimeUsd).toBeCloseTo(0.0077, 6);
  });

  it('notifies subscribers with the updated session and lifetime totals after a recording', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    const calls: Array<[number, number]> = [];
    tracker.onUpdate((sessionUsd, lifetimeUsd) => calls.push([sessionUsd, lifetimeUsd]));

    tracker.recordDeepgramSeconds(60);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeCloseTo(0.0077, 6);
    expect(calls[0][1]).toBeCloseTo(0.0077, 6);
  });

  it('stops notifying a listener after it unsubscribes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cost-test-'));
    const tracker = createCostTracker(join(tempDir, 'cost.json'));

    const calls: Array<[number, number]> = [];
    const unsubscribe = tracker.onUpdate((sessionUsd, lifetimeUsd) => calls.push([sessionUsd, lifetimeUsd]));
    unsubscribe();

    tracker.recordDeepgramSeconds(60);

    expect(calls).toHaveLength(0);
  });
});
