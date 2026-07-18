import { describe, it, expect } from 'vitest';
import { createOpenRouterClient } from '../src/openRouterClient';

describe('createOpenRouterClient', () => {
  it('returns a client exposing chat.completions.create as a callable function', () => {
    const client = createOpenRouterClient('fake-api-key');
    expect(typeof client.chat.completions.create).toBe('function');
  });
});
