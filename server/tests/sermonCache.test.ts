import { describe, it, expect, vi } from 'vitest';
import { createRoleCaches, deleteRoleCaches } from '../src/sermonCache';
import type { GeminiClient } from '../src/gemini';
import type { ModelConfig } from '../src/modelConfigStore';
import type { PromptConfig } from '../src/promptConfigStore';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LOG_FILE_PATH = join(tmpdir(), 'auto-translate-lite-test-events.log');

function fakeClientWithCaches(): GeminiClient {
  let counter = 0;
  return {
    models: { generateContent: vi.fn() },
    caches: {
      create: vi.fn().mockImplementation(() => {
        counter += 1;
        return Promise.resolve({ name: `cachedContents/${counter}` });
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const modelConfig: ModelConfig = {
  transcriptionVerifier: 'gemini-3.1-flash-lite',
  translation: 'gemini-3.5-flash',
  translationVerifier: 'gemini-3.1-flash-lite',
};

const promptConfig: PromptConfig = {
  transcriptionVerifier: 'tv notes',
  translation: 't notes',
  translationVerifier: 'vv notes',
};

// Gemini rejects cached content under 1024 tokens (~4.5 chars/token here, see
// sermonCache.ts). Fixed rules + short notes alone fall well short of that,
// so tests exercising the "cache actually gets created" path need enough
// padding to realistically cross the threshold, the way a real sermon
// document would.
const PADDING = 'Today we talk about faith and hope in difficult times. '.repeat(100);

describe('createRoleCaches', () => {
  it('skips cache creation entirely for every role when there is no sermon document or feedback text, since fixed rules + notes alone fall well under the 1024-token minimum Gemini requires', async () => {
    const client = fakeClientWithCaches();
    const caches = await createRoleCaches(client, modelConfig, promptConfig, '', '');
    expect(client.caches.create).not.toHaveBeenCalled();
    expect(caches.transcriptionVerifier).toBeNull();
    expect(caches.translation).toBeNull();
    expect(caches.translationVerifier).toBeNull();
  });

  it('creates each role\'s cache against that role\'s configured model once enough sermon material is present', async () => {
    const client = fakeClientWithCaches();
    await createRoleCaches(client, modelConfig, promptConfig, '', PADDING);
    const createCalls = (client.caches.create as any).mock.calls.map((call: any) => call[0].model);
    expect(createCalls).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite']);
  });

  it("includes each role's fixed rules and editable notes in its own systemInstruction, not the other roles'", async () => {
    const client = fakeClientWithCaches();
    await createRoleCaches(client, modelConfig, promptConfig, '', PADDING);
    const instructions = (client.caches.create as any).mock.calls.map((call: any) => call[0].config.systemInstruction);
    expect(instructions[0]).toContain('tv notes');
    expect(instructions[0]).not.toContain('t notes and'); // sanity: not leaking translation notes verbatim as a substring collision
    expect(instructions[1]).toContain('t notes');
    expect(instructions[1]).toContain('Preserve polarity and negation exactly');
    expect(instructions[2]).toContain('vv notes');
  });

  it('includes shared feedback and sermon material in every role\'s cache', async () => {
    const client = fakeClientWithCaches();
    await createRoleCaches(
      client,
      modelConfig,
      promptConfig,
      `Cain should be 该隐 in Chinese. ${PADDING}`,
      `Today we talk about Cain and Abel. ${PADDING}`
    );
    const instructions = (client.caches.create as any).mock.calls.map((call: any) => call[0].config.systemInstruction);
    for (const instruction of instructions) {
      expect(instruction).toContain('Known corrections from past sessions');
      expect(instruction).toContain('Cain should be 该隐');
      expect(instruction).toContain("This week's sermon material");
      expect(instruction).toContain('Cain and Abel');
    }
  });

  it('omits the feedback section when feedback text is empty', async () => {
    const client = fakeClientWithCaches();
    await createRoleCaches(client, modelConfig, promptConfig, '', `Sermon content here. ${PADDING}`);
    const instructions = (client.caches.create as any).mock.calls.map((call: any) => call[0].config.systemInstruction);
    for (const instruction of instructions) {
      expect(instruction).not.toContain('Known corrections from past sessions');
      expect(instruction).toContain('Sermon content here.');
    }
  });

  it("returns null for a role's cache and logs, without affecting the other roles, when that role's cache creation fails", async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClientWithCaches();
    (client.caches.create as any).mockImplementationOnce(() => Promise.reject(new Error('API down')));
    const caches = await createRoleCaches(client, modelConfig, promptConfig, '', PADDING);
    expect(caches.transcriptionVerifier).toBeNull();
    expect(caches.translation).not.toBeNull();
    expect(caches.translationVerifier).not.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('deleteRoleCaches', () => {
  it('deletes every non-null role cache by name', async () => {
    const client = fakeClientWithCaches();
    await deleteRoleCaches(client, {
      transcriptionVerifier: { name: 'cachedContents/a' },
      translation: { name: 'cachedContents/b' },
      translationVerifier: null,
    });
    expect(client.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/a' });
    expect(client.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/b' });
    expect(client.caches.delete).toHaveBeenCalledTimes(2);
  });

  it('does nothing when all role caches are null', async () => {
    const client = fakeClientWithCaches();
    await deleteRoleCaches(client, { transcriptionVerifier: null, translation: null, translationVerifier: null });
    expect(client.caches.delete).not.toHaveBeenCalled();
  });
});
