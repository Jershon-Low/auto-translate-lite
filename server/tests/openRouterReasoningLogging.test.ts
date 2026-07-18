import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withOpenRouterReasoningLogging } from '../src/openRouterReasoningLogging';
import type { OpenRouterClient } from '../src/openRouterClient';

function fakeClient(content: string, reasoning?: string): OpenRouterClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content, reasoning } }] }),
      },
    },
  };
}

describe('withOpenRouterReasoningLogging', () => {
  let tempDir: string;

  afterEach(async () => {
    delete process.env.LOG_FILE_PATH;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('logs an openrouter_reasoning event with model, schema name, and reasoning text when present', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reasoning-logging-test-'));
    process.env.LOG_FILE_PATH = join(tempDir, 'events.log');
    const client = fakeClient('{"zh":"你好"}', 'Thinking about tone...');
    const wrapped = withOpenRouterReasoningLogging(client);

    await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_schema', json_schema: { name: 'translate', schema: {} } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = await readFile(process.env.LOG_FILE_PATH!, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed).toMatchObject({
      level: 'info',
      event: 'openrouter_reasoning',
      model: 'qwen/qwen3.6-flash',
      schema: 'translate',
      reasoning: 'Thinking about tone...',
    });
  });

  it('does not log when message.reasoning is absent', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reasoning-logging-test-'));
    process.env.LOG_FILE_PATH = join(tempDir, 'events.log');
    const client = fakeClient('{"zh":"你好"}');
    const wrapped = withOpenRouterReasoningLogging(client);

    await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(readFile(process.env.LOG_FILE_PATH!, 'utf-8')).rejects.toThrow();
  });

  it('still returns the original response unchanged', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reasoning-logging-test-'));
    process.env.LOG_FILE_PATH = join(tempDir, 'events.log');
    const client = fakeClient('{"zh":"你好"}', 'thinking');
    const wrapped = withOpenRouterReasoningLogging(client);

    const response = await wrapped.chat.completions.create({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(response).toEqual({ choices: [{ message: { content: '{"zh":"你好"}', reasoning: 'thinking' } }] });
  });
});
