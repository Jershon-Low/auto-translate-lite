import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logEvent } from '../src/logger';
import { logHub } from '../src/logHub';

describe('logEvent', () => {
  let tempDir: string;

  afterEach(async () => {
    delete process.env.LOG_FILE_PATH;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('writes a structured JSON line to the log file, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
    const logPath = join(tempDir, 'nested', 'events.log');
    process.env.LOG_FILE_PATH = logPath;

    await logEvent('warn', { event: 'translation_fallback', language: 'zh', reason: 'polarity flip' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = await readFile(logPath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed).toMatchObject({ level: 'warn', event: 'translation_fallback', language: 'zh', reason: 'polarity flip' });
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('appends multiple events as separate lines in order', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
    process.env.LOG_FILE_PATH = join(tempDir, 'events.log');

    await logEvent('warn', { event: 'first' });
    await logEvent('error', { event: 'second' });

    const content = await readFile(process.env.LOG_FILE_PATH, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('first');
    expect(JSON.parse(lines[1]).event).toBe('second');
  });

  it('logs to console.warn for warn level and console.error for error level', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
    process.env.LOG_FILE_PATH = join(tempDir, 'events.log');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await logEvent('warn', { event: 'a' });
    await logEvent('error', { event: 'b' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('pushes a well-formed entry into logHub', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
    process.env.LOG_FILE_PATH = join(tempDir, 'events.log');

    await logEvent('warn', { event: 'unit_test_event', detail: 42 });
    const last = logHub.getHistory().at(-1);
    expect(last).toMatchObject({ level: 'warn', event: 'unit_test_event', detail: 42 });
    expect(typeof last?.timestamp).toBe('string');
  });
});
