import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, '..', 'src');
const PHRASING_FILE = join(HERE, '..', '..', 'web', 'lib', 'logFormat.ts');

async function eventNamesInSource(): Promise<string[]> {
  const names = new Set<string>();
  for (const file of await readdir(SRC_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(join(SRC_DIR, file), 'utf-8');
    for (const match of source.matchAll(/event: '([a-z_]+)'/g)) names.add(match[1]);
  }
  return [...names].sort();
}

describe('log phrasing coverage', () => {
  it('finds the event names emitted by the server', async () => {
    const names = await eventNamesInSource();
    // Guards the regex itself: if it silently stopped matching, every
    // coverage assertion below would vacuously pass.
    expect(names.length).toBeGreaterThan(30);
    expect(names).toContain('translation_fallback');
  });

  it('has a phrasing in web/lib/logFormat.ts for every event the server emits', async () => {
    const phrasings = await readFile(PHRASING_FILE, 'utf-8');
    const missing = (await eventNamesInSource()).filter((name) => !phrasings.includes(`${name}:`));
    // Reading the file as text rather than importing it: the two packages have
    // separate builds and module resolution, and this only needs to know a key
    // is present.
    expect(missing).toEqual([]);
  });
});
