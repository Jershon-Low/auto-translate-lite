# Unsafe-Translation Display Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin switch how the app handles a translation the verifier flags as unsafe — from today's silent fallback to English, to showing the real translation in the viewer marked in a distinct red with the verifier's reason attached, so native speakers can review the verifier's judgment directly.

**Architecture:** A new persisted `hide`/`flag` config (read once at session Start, same pattern as model/prompt config) drives a branch in `wsServer.ts`'s existing safe/unsafe handling. `TranslationCache` grows from storing a plain string to storing `{ translated, flagged, reason? }`, so a flagged line's status survives for viewers who join or refresh later. The viewer-facing WebSocket messages carry the new fields only when a line is actually flagged, keeping the wire format unchanged by default.

**Tech Stack:** Node/TypeScript/Express/vitest (server), Next.js 16 App Router/React 19/Tailwind (web) — no new runtime dependencies.

## Global Constraints

- Default mode is `'hide'` — today's exact behavior (silent English fallback, no `flagged`/`reason` fields ever on the wire). Shipping this must not change anything until an admin explicitly switches the setting.
- The mode is read once per session Start (same pattern as model/prompt config) — a mid-service toggle flip only affects the *next* Start, never hot-reloaded into a running session.
- The new admin routes are gated by the existing `adminAuth` middleware — no new auth surface, no route outside `/admin/*` gains auth it didn't have.
- Flagged-line styling in the viewer uses a distinct rose-red (`text-rose-600 dark:text-rose-400`), never the app's existing `text-destructive` class — that color is reserved for actual app errors (failed PDF export, failed feedback submit), and reusing it would make a flagged translation look like a bug in the app itself.
- No new npm dependencies. Follow the existing flat `server/src/*.ts` layout — no new subdirectories.

---

### Task 1: Persisted display-mode config store

**Files:**
- Create: `server/src/translationFlagDisplayStore.ts`
- Test: `server/tests/translationFlagDisplayStore.test.ts`

**Interfaces:**
- Produces: `TranslationFlagDisplayMode` (`'hide' | 'flag'`), `TranslationFlagDisplayConfig { mode: TranslationFlagDisplayMode }`, `DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG` (`{ mode: 'hide' }`), `createTranslationFlagDisplayStore(filePath): TranslationFlagDisplayStore`, `validateTranslationFlagDisplayConfig(value): TranslationFlagDisplayConfig | null`. Tasks 3 and 4 both consume these exact names.

This follows `server/src/modelConfigStore.ts`'s exact pattern — a single JSON-file-backed store with a validate function used both internally (silent fallback to default) and externally (the PUT route rejects bad input with 400).

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/translationFlagDisplayStore.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTranslationFlagDisplayStore,
  validateTranslationFlagDisplayConfig,
  DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG,
} from '../src/translationFlagDisplayStore';

describe('createTranslationFlagDisplayStore', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the default config (hide) when the file does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'translation-flag-display-test-'));
    const store = createTranslationFlagDisplayStore(join(tempDir, 'translation-flag-display.json'));
    expect(await store.read()).toEqual(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG);
  });

  it('writes then reads back the same config, creating parent directories as needed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'translation-flag-display-test-'));
    const filePath = join(tempDir, 'nested', 'translation-flag-display.json');
    const store = createTranslationFlagDisplayStore(filePath);
    await store.write({ mode: 'flag' });
    expect(await store.read()).toEqual({ mode: 'flag' });
  });

  it('falls back to the default config when the file is corrupt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'translation-flag-display-test-'));
    const filePath = join(tempDir, 'translation-flag-display.json');
    await writeFile(filePath, 'not json', 'utf-8');
    const store = createTranslationFlagDisplayStore(filePath);
    expect(await store.read()).toEqual(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG);
  });

  it('falls back to the default config when the file has an invalid mode', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'translation-flag-display-test-'));
    const filePath = join(tempDir, 'translation-flag-display.json');
    await writeFile(filePath, JSON.stringify({ mode: 'delete-everything' }), 'utf-8');
    const store = createTranslationFlagDisplayStore(filePath);
    expect(await store.read()).toEqual(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG);
  });
});

describe('validateTranslationFlagDisplayConfig', () => {
  it('accepts mode: "hide"', () => {
    expect(validateTranslationFlagDisplayConfig({ mode: 'hide' })).toEqual({ mode: 'hide' });
  });

  it('accepts mode: "flag"', () => {
    expect(validateTranslationFlagDisplayConfig({ mode: 'flag' })).toEqual({ mode: 'flag' });
  });

  it('rejects an unrecognized mode', () => {
    expect(validateTranslationFlagDisplayConfig({ mode: 'nonsense' })).toBeNull();
  });

  it('rejects a non-object value', () => {
    expect(validateTranslationFlagDisplayConfig(null)).toBeNull();
    expect(validateTranslationFlagDisplayConfig('hide')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run tests/translationFlagDisplayStore.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `translationFlagDisplayStore.ts`**

```ts
// server/src/translationFlagDisplayStore.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type TranslationFlagDisplayMode = 'hide' | 'flag';

export interface TranslationFlagDisplayConfig {
  mode: TranslationFlagDisplayMode;
}

export const DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG: TranslationFlagDisplayConfig = { mode: 'hide' };

export interface TranslationFlagDisplayStore {
  read(): Promise<TranslationFlagDisplayConfig>;
  write(config: TranslationFlagDisplayConfig): Promise<void>;
}

export function validateTranslationFlagDisplayConfig(value: unknown): TranslationFlagDisplayConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== 'hide' && candidate.mode !== 'flag') return null;
  return { mode: candidate.mode };
}

export function createTranslationFlagDisplayStore(filePath: string): TranslationFlagDisplayStore {
  return {
    async read(): Promise<TranslationFlagDisplayConfig> {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const validated = validateTranslationFlagDisplayConfig(JSON.parse(raw));
        return validated ?? DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG;
      } catch {
        return DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG;
      }
    },
    async write(config: TranslationFlagDisplayConfig): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(config), 'utf-8');
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes, then run the full suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/translationFlagDisplayStore.ts server/tests/translationFlagDisplayStore.test.ts
git commit -m "Add persisted hide/flag config store for unsafe-translation display"
```

---

### Task 2: `TranslationCache` stores flag/reason alongside the text

**Files:**
- Modify: `server/src/translationCache.ts`
- Modify: `server/src/wsServer.ts` (call sites only — no mode-branching behavior yet)
- Modify: `server/tests/session.test.ts:85-90` (one `.set()` call)
- Test: `server/tests/translationCache.test.ts`
- Test: `server/tests/wsServer.test.ts` (4 assertions that read `.get(...)` as a plain string)

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `CachedTranslation { translated: string; flagged: boolean; reason?: string }`, `TranslationCache.get(language, lineId): CachedTranslation | undefined`, `TranslationCache.set(language, lineId, entry: CachedTranslation): void`. Task 3 uses this exact shape to add the real flag/reason values.

This task is a pure representation change — every call site is updated to wrap/unwrap the new shape, but every entry written is still `{ translated: <same value as before>, flagged: false }`. No observable behavior changes; this is the "stopgap" migration that Task 3 builds real behavior on top of.

- [ ] **Step 1: Write the failing test for the new `get`/`set` shape**

Replace the full contents of `server/tests/translationCache.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TranslationCache } from '../src/translationCache';

describe('TranslationCache', () => {
  it('returns undefined for a line that was never cached', () => {
    const cache = new TranslationCache();
    expect(cache.get('zh', 'line-1')).toBeUndefined();
  });

  it('set/get roundtrips a translated line for a given language', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', { translated: '你好', flagged: false });
    expect(cache.get('zh', 'line-1')).toEqual({ translated: '你好', flagged: false });
  });

  it('roundtrips a flagged entry including its reason', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', { translated: '耶稣不爱你', flagged: true, reason: 'polarity flip' });
    expect(cache.get('zh', 'line-1')).toEqual({ translated: '耶稣不爱你', flagged: true, reason: 'polarity flip' });
  });

  it('keeps the same line id independent across different languages', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', { translated: '你好', flagged: false });
    cache.set('fr', 'line-1', { translated: 'Bonjour', flagged: false });
    expect(cache.get('zh', 'line-1')).toEqual({ translated: '你好', flagged: false });
    expect(cache.get('fr', 'line-1')).toEqual({ translated: 'Bonjour', flagged: false });
  });

  it('overwrites a previously cached value for the same language and line id', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', { translated: '你好', flagged: false });
    cache.set('zh', 'line-1', { translated: '你好呀', flagged: false });
    expect(cache.get('zh', 'line-1')).toEqual({ translated: '你好呀', flagged: false });
  });

  it('clear() empties every language', () => {
    const cache = new TranslationCache();
    cache.set('zh', 'line-1', { translated: '你好', flagged: false });
    cache.set('fr', 'line-1', { translated: 'Bonjour', flagged: false });
    cache.clear();
    expect(cache.get('zh', 'line-1')).toBeUndefined();
    expect(cache.get('fr', 'line-1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run tests/translationCache.test.ts`
Expected: FAIL — `set`/`get` still use the old plain-string shape.

- [ ] **Step 3: Update `translationCache.ts`**

Replace the full contents of `server/src/translationCache.ts`:

```ts
export interface CachedTranslation {
  translated: string;
  flagged: boolean;
  reason?: string;
}

export class TranslationCache {
  private byLanguage: Map<string, Map<string, CachedTranslation>> = new Map();

  get(language: string, lineId: string): CachedTranslation | undefined {
    return this.byLanguage.get(language)?.get(lineId);
  }

  set(language: string, lineId: string, entry: CachedTranslation): void {
    let lines = this.byLanguage.get(language);
    if (!lines) {
      lines = new Map();
      this.byLanguage.set(language, lines);
    }
    lines.set(lineId, entry);
  }

  clear(): void {
    this.byLanguage.clear();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run tests/translationCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Update every `translationCache` call site in `wsServer.ts`**

Edit `server/src/wsServer.ts`. In `finishPublishing`, change:

```ts
    const outgoing = safe ? translated : line.english;
    deps.session.translationCache.set(language, line.id, outgoing);
```

to:

```ts
    const outgoing = safe ? translated : line.english;
    deps.session.translationCache.set(language, line.id, { translated: outgoing, flagged: false });
```

In `ensureBacklogCached`'s catch block, change:

```ts
      for (const line of missingEntries) {
        cache.set(language, line.id, line.english);
      }
```

to:

```ts
      for (const line of missingEntries) {
        cache.set(language, line.id, { translated: line.english, flagged: false });
      }
```

In `ensureBacklogCached`'s `missingEntries.forEach` block, change:

```ts
    missingEntries.forEach((line, index) => {
      const translated = translations[index];
      if (!translated) {
        cache.set(language, line.id, line.english);
        return;
      }
      const verification = verifications[line.id];
      if (verification?.safe === true) {
        cache.set(language, line.id, translated);
        return;
      }
      logTranslationFallback(language, line.english, translated, verification?.reason || 'verification unavailable');
      cache.set(language, line.id, line.english);
    });
```

to:

```ts
    missingEntries.forEach((line, index) => {
      const translated = translations[index];
      if (!translated) {
        cache.set(language, line.id, { translated: line.english, flagged: false });
        return;
      }
      const verification = verifications[line.id];
      if (verification?.safe === true) {
        cache.set(language, line.id, { translated, flagged: false });
        return;
      }
      logTranslationFallback(language, line.english, translated, verification?.reason || 'verification unavailable');
      cache.set(language, line.id, { translated: line.english, flagged: false });
    });
```

In `handleViewerConnection`, change:

```ts
          const lines = backlog.map((line) =>
            line.suppressed
              ? { id: line.id, english: '', translated: '', removed: true }
              : { id: line.id, english: line.english, translated: cache.get(language, line.id) ?? line.english }
          );
```

to:

```ts
          const lines = backlog.map((line) =>
            line.suppressed
              ? { id: line.id, english: '', translated: '', removed: true }
              : { id: line.id, english: line.english, translated: cache.get(language, line.id)?.translated ?? line.english }
          );
```

- [ ] **Step 6: Update the one `.set()` call in `session.test.ts`**

Edit `server/tests/session.test.ts:87`, change:

```ts
    session.translationCache.set('zh', 'old-line', '你好');
```

to:

```ts
    session.translationCache.set('zh', 'old-line', { translated: '你好', flagged: false });
```

- [ ] **Step 7: Update the four `.get()` assertions in `wsServer.test.ts` that read the old plain-string shape**

Edit `server/tests/wsServer.test.ts`. Change each of these four lines from asserting a bare string to asserting the `.translated` property:

Line ~1058 (`'caches the live-published translation for each active language'`):
```ts
      expect(session.translationCache.get('zh', caption.id)).toBe('你好');
```
becomes:
```ts
      expect(session.translationCache.get('zh', caption.id)?.translated).toBe('你好');
```

Line ~1090 (`'caches the English fallback when the verifier flags a translation as unsafe'`):
```ts
      expect(session.translationCache.get('zh', caption.id)).toBe('Jesus loves you');
```
becomes:
```ts
      expect(session.translationCache.get('zh', caption.id)?.translated).toBe('Jesus loves you');
```

Line ~1114 (`'does not cache anything for a language with no translation at all for that line'`) — no change needed, `.toBeUndefined()` still holds since `get` still returns `undefined` when nothing was cached.

Line ~1250 (`'a viewer subscribing after a reinstated correction sees the cached corrected translation...'`):
```ts
      expect(session.translationCache.get('zh', flagged.id)).toBe('耶稣确实是神的儿子');
```
becomes:
```ts
      expect(session.translationCache.get('zh', flagged.id)?.translated).toBe('耶稣确实是神的儿子');
```

- [ ] **Step 8: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: PASS — zero behavior change, every existing test still passes.

- [ ] **Step 9: Commit**

```bash
git add server/src/translationCache.ts server/src/wsServer.ts server/tests/translationCache.test.ts server/tests/session.test.ts server/tests/wsServer.test.ts
git commit -m "Store flag/reason alongside cached translations (no behavior change yet)"
```

---

### Task 3: Wire the display mode into `Session` and `wsServer.ts`

**Files:**
- Modify: `server/src/session.ts`
- Modify: `server/src/wsServer.ts`
- Modify: `server/tests/session.test.ts`
- Modify: `server/tests/wsServer.test.ts`

**Interfaces:**
- Consumes: `TranslationFlagDisplayMode`, `TranslationFlagDisplayStore` (Task 1); `CachedTranslation` (Task 2).
- Produces: `Session.translationFlagDisplayMode: TranslationFlagDisplayMode` (defaults `'hide'`, reset in `start()`); `WsServerDeps` gains `translationFlagDisplayStore: TranslationFlagDisplayStore`. Task 4 (index.ts wiring) constructs and passes this dep; Task 6 (viewer frontend) consumes the resulting `flagged`/`reason` fields on the wire.

This is the task that makes the toggle actually do something.

- [ ] **Step 1: Update `session.ts`**

Edit `server/src/session.ts`. Add the import:

```ts
import type { TranslationFlagDisplayMode } from './translationFlagDisplayStore.js';
```

Add the field (after `mode: 'automatic' | 'manual' = 'automatic';`):

```ts
  translationFlagDisplayMode: TranslationFlagDisplayMode = 'hide';
```

In `start()`, add a line resetting it to the default (after `this.inFlightFills = new Map();`):

```ts
    this.translationFlagDisplayMode = 'hide';
```

- [ ] **Step 2: Add the reset test to `session.test.ts`**

Add to `server/tests/session.test.ts`, after the `'start() replaces the in-flight fill map...'` test:

```ts
  it('start() resets translationFlagDisplayMode to the default (hide)', () => {
    const session = new Session();
    session.translationFlagDisplayMode = 'flag';
    session.start();
    expect(session.translationFlagDisplayMode).toBe('hide');
  });
```

- [ ] **Step 3: Run `session.test.ts`**

Run: `cd server && npx vitest run tests/session.test.ts`
Expected: PASS.

- [ ] **Step 4: Update `WsServerDeps` and the `'start'` handler in `wsServer.ts`**

Edit `server/src/wsServer.ts`. Add the import:

```ts
import type { TranslationFlagDisplayStore } from './translationFlagDisplayStore.js';
```

Add the field to `WsServerDeps` (after `promptConfigStore: PromptConfigStore;`):

```ts
  translationFlagDisplayStore: TranslationFlagDisplayStore;
```

In the `'start'` handler, after the line `const promptConfig = await deps.promptConfigStore.read();`, add:

```ts
            const translationFlagDisplayConfig = await deps.translationFlagDisplayStore.read();
```

And after the line `deps.session.roleCaches = await createRoleCaches(...)`, add:

```ts
            deps.session.translationFlagDisplayMode = translationFlagDisplayConfig.mode;
```

- [ ] **Step 5: Update `finishPublishing` to branch on mode**

Replace the full body of `finishPublishing` in `server/src/wsServer.ts`:

```ts
async function finishPublishing(
  line: CaptionLine,
  translations: Record<string, string>,
  deps: WsServerDeps,
  captureSocket: WebSocket,
  viewerMessageType: 'caption' | 'caption-inserted' = 'caption'
): Promise<void> {
  captureSocket.send(JSON.stringify({ type: 'transcript', id: line.id, english: line.english }));

  const activeLanguages = deps.session.getActiveLanguages();
  if (activeLanguages.length === 0) return;

  const verificationItems: VerificationItem[] = activeLanguages
    .filter((language) => Boolean(translations[language]))
    .map((language) => ({ id: language, english: line.english, translated: translations[language] }));
  const verifications = await verifyTranslationsWithRetry(deps, verificationItems);
  const flagMode = deps.session.translationFlagDisplayMode === 'flag';

  for (const language of activeLanguages) {
    const translated = translations[language];
    if (!translated) continue;

    const verification = verifications[language];
    const safe = verification?.safe === true;
    const outgoing = flagMode || safe ? translated : line.english;
    const flagged = flagMode && !safe;
    const reason = verification?.reason || 'verification unavailable';

    if (!safe) {
      logTranslationFallback(language, line.english, translated, reason);
    }

    deps.session.translationCache.set(
      language,
      line.id,
      flagged ? { translated: outgoing, flagged: true, reason } : { translated: outgoing, flagged: false }
    );

    const payload = JSON.stringify({
      type: viewerMessageType,
      id: line.id,
      english: line.english,
      translated: outgoing,
      ...(flagged ? { flagged: true, reason } : {}),
    });
    for (const viewerSocket of deps.session.getViewersForLanguage(language)) {
      viewerSocket.send(payload);
    }
  }
}
```

- [ ] **Step 6: Update `ensureBacklogCached` to branch on mode**

Replace the `missingEntries.forEach` block inside `ensureBacklogCached` in `server/src/wsServer.ts`:

```ts
    const flagMode = deps.session.translationFlagDisplayMode === 'flag';
    missingEntries.forEach((line, index) => {
      const translated = translations[index];
      if (!translated) {
        cache.set(language, line.id, { translated: line.english, flagged: false });
        return;
      }
      const verification = verifications[line.id];
      if (verification?.safe === true) {
        cache.set(language, line.id, { translated, flagged: false });
        return;
      }
      const reason = verification?.reason || 'verification unavailable';
      logTranslationFallback(language, line.english, translated, reason);
      if (flagMode) {
        cache.set(language, line.id, { translated, flagged: true, reason });
      } else {
        cache.set(language, line.id, { translated: line.english, flagged: false });
      }
    });
```

- [ ] **Step 7: Add a `buildBacklogLine` helper and use it in `handleViewerConnection`**

Add this function to `server/src/wsServer.ts`, just above `handleViewerConnection`:

```ts
function buildBacklogLine(
  line: CaptionLine,
  cache: Session['translationCache'],
  language: string
): Record<string, unknown> {
  if (line.suppressed) return { id: line.id, english: '', translated: '', removed: true };
  const cached = cache.get(language, line.id);
  return {
    id: line.id,
    english: line.english,
    translated: cached?.translated ?? line.english,
    ...(cached?.flagged ? { flagged: true, reason: cached.reason } : {}),
  };
}
```

Replace the `lines` construction inside `handleViewerConnection`:

```ts
          const lines = backlog.map((line) =>
            line.suppressed
              ? { id: line.id, english: '', translated: '', removed: true }
              : { id: line.id, english: line.english, translated: cache.get(language, line.id)?.translated ?? line.english }
          );
```

with:

```ts
          const lines = backlog.map((line) => buildBacklogLine(line, cache, language));
```

Note: `import type { Session } from './session.js';` already exists at the top of the file — no new import needed for the `Session['translationCache']` type reference.

- [ ] **Step 8: Update `wsServer.test.ts`'s test setup**

Add these imports near the top of `server/tests/wsServer.test.ts`, alongside the existing config-store imports:

```ts
import {
  DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG,
  type TranslationFlagDisplayStore,
} from '../src/translationFlagDisplayStore';
```

Add this fake factory function after `fakePromptConfigStore`:

```ts
function fakeTranslationFlagDisplayStore(): TranslationFlagDisplayStore {
  return {
    read: vi.fn().mockResolvedValue(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG),
    write: vi.fn().mockResolvedValue(undefined),
  };
}
```

Add a new outer-scope variable alongside the existing `let feedbackStore: FeedbackStore;`:

```ts
  let translationFlagDisplayStore: TranslationFlagDisplayStore;
```

In the `beforeEach` block, assign it and add it to the `attachWsServer(...)` call:

```ts
    translationFlagDisplayStore = fakeTranslationFlagDisplayStore();

    attachWsServer({
      httpServer,
      session,
      geminiClient,
      deepgramApiKey: 'fake-key',
      createDeepgramConnection: (_apiKey, callbacks) => {
        capturedCallbacks = callbacks;
        return { send: vi.fn(), finish: vi.fn() };
      },
      sermonDocStore,
      feedbackStore,
      costTracker,
      modelConfigStore: fakeModelConfigStore(),
      promptConfigStore: fakePromptConfigStore(),
      translationFlagDisplayStore,
    });
```

- [ ] **Step 9: Add the new `'unsafe translation display mode'` describe block**

Add to `server/tests/wsServer.test.ts`, after the `'translation cache (viewer subscribe burst fix)'` describe block closes:

```ts
  describe('unsafe translation display mode', () => {
    it('flag mode: sends the real translation marked flagged with the reason, and a later viewer sees it in backlog too', async () => {
      (translationFlagDisplayStore.read as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'flag' });
      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('transcription accuracy checker')) {
          return Promise.resolve({ text: '{"safe":true,"reason":"ok"}' });
        }
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: '{"zh":{"safe":false,"reason":"polarity flip"}}' });
        }
        return Promise.resolve({ text: '{"zh":"耶稣不爱你"}' });
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const firstViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(firstViewer);
      firstViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(firstViewer); // backlog: []

      const captionPromise = waitForMessage(firstViewer);
      capturedCallbacks!.onFinalSegment('Jesus loves you');
      const caption = await captionPromise;

      expect(caption).toEqual({
        type: 'caption',
        id: expect.any(String),
        english: 'Jesus loves you',
        translated: '耶稣不爱你',
        flagged: true,
        reason: 'polarity flip',
      });
      expect(session.translationCache.get('zh', caption.id)).toEqual({
        translated: '耶稣不爱你',
        flagged: true,
        reason: 'polarity flip',
      });

      const secondViewer = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(secondViewer);
      secondViewer.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      const backlogMessage = await waitForMessage(secondViewer);

      expect(backlogMessage).toEqual({
        type: 'backlog',
        lines: [
          { id: caption.id, english: 'Jesus loves you', translated: '耶稣不爱你', flagged: true, reason: 'polarity flip' },
        ],
      });

      warnSpy.mockRestore();
      captureSocket.close();
      firstViewer.close();
      secondViewer.close();
    });

    it('flag mode: a safe translation is delivered exactly as in hide mode, with no flagged/reason fields', async () => {
      (translationFlagDisplayStore.read as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'flag' });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      await waitForMessage(viewerSocket); // backlog: []

      const captionPromise = waitForMessage(viewerSocket);
      capturedCallbacks!.onFinalSegment('Hello everyone');
      const caption = await captionPromise;

      expect(caption).toEqual({ type: 'caption', id: expect.any(String), english: 'Hello everyone', translated: '你好' });
      expect(caption).not.toHaveProperty('flagged');
      expect(session.translationCache.get('zh', caption.id)).toEqual({ translated: '你好', flagged: false });

      captureSocket.close();
      viewerSocket.close();
    });

    it('flag mode: an unsafe backlog-fill translation is cached flagged and delivered with the reason', async () => {
      (translationFlagDisplayStore.read as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'flag' });

      const captureSocket = new WebSocket(`ws://localhost:${port}/ws/capture`);
      await waitForOpen(captureSocket);
      captureSocket.send(JSON.stringify({ type: 'start' }));
      await waitForMessage(captureSocket); // status: recording

      const line = session.buffer.append('Jesus loves you', Date.now());

      (geminiClient.models.generateContent as any).mockImplementation((params: { contents: string }) => {
        if (params.contents.includes('safety checker')) {
          return Promise.resolve({ text: JSON.stringify({ [line.id]: { safe: false, reason: 'polarity flip' } }) });
        }
        return Promise.resolve({ text: '{"translations":["耶稣不爱你"]}' });
      });

      const viewerSocket = new WebSocket(`ws://localhost:${port}/ws/viewer`);
      await waitForOpen(viewerSocket);
      viewerSocket.send(JSON.stringify({ type: 'subscribe', language: 'zh' }));
      const backlogMessage = await waitForMessage(viewerSocket);

      expect(backlogMessage).toEqual({
        type: 'backlog',
        lines: [{ id: line.id, english: 'Jesus loves you', translated: '耶稣不爱你', flagged: true, reason: 'polarity flip' }],
      });
      expect(session.translationCache.get('zh', line.id)).toEqual({
        translated: '耶稣不爱你',
        flagged: true,
        reason: 'polarity flip',
      });

      captureSocket.close();
      viewerSocket.close();
    });
  });
```

- [ ] **Step 10: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add server/src/session.ts server/src/wsServer.ts server/tests/session.test.ts server/tests/wsServer.test.ts
git commit -m "Wire the unsafe-translation display mode into Session and wsServer"
```

---

### Task 4: Admin REST routes and server wiring

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Modify: `server/tests/app.test.ts`

**Interfaces:**
- Consumes: `TranslationFlagDisplayStore`, `validateTranslationFlagDisplayConfig`, `createTranslationFlagDisplayStore`, `DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG` (Task 1).
- Produces: `GET/PUT /admin/translation-flag-display`, gated by the existing `adminAuth` middleware. Task 5 (frontend) calls these exact routes.

- [ ] **Step 1: Write the failing tests**

Add this import to `server/tests/app.test.ts`, alongside the existing config-store imports:

```ts
import {
  createTranslationFlagDisplayStore,
  DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG,
} from '../src/translationFlagDisplayStore';
```

Update `testDeps()` to include the new store:

```ts
function testDeps() {
  return {
    sermonDocStore: createSermonDocStore(),
    feedbackStore: createFeedbackStore(join(tmpdir(), `feedback-app-test-${Date.now()}-${Math.random()}.txt`)),
    viewerFeedbackStore: createViewerFeedbackStore(
      join(tmpdir(), `viewer-feedback-app-test-${Date.now()}-${Math.random()}.json`)
    ),
    session: new Session(),
    modelConfigStore: createModelConfigStore(join(tmpdir(), `model-config-app-test-${Date.now()}-${Math.random()}.json`)),
    promptConfigStore: createPromptConfigStore(join(tmpdir(), `prompt-config-app-test-${Date.now()}-${Math.random()}.json`)),
    translationFlagDisplayStore: createTranslationFlagDisplayStore(
      join(tmpdir(), `translation-flag-display-app-test-${Date.now()}-${Math.random()}.json`)
    ),
    adminPasscode: 'test-passcode',
  };
}
```

Add this describe block at the end of `server/tests/app.test.ts`:

```ts
describe('GET/PUT /admin/translation-flag-display', () => {
  it('returns 401 without the admin passcode header', async () => {
    const response = await request(createApp(testDeps())).get('/admin/translation-flag-display');
    expect(response.status).toBe(401);
  });

  it('returns the default config (hide) on first read', async () => {
    const response = await request(createApp(testDeps()))
      .get('/admin/translation-flag-display')
      .set('x-admin-passcode', 'test-passcode');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG);
  });

  it('saves a valid config and returns it on a subsequent read', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const putResponse = await request(app)
      .put('/admin/translation-flag-display')
      .set('x-admin-passcode', 'test-passcode')
      .send({ mode: 'flag' });
    expect(putResponse.status).toBe(200);

    const getResponse = await request(app)
      .get('/admin/translation-flag-display')
      .set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual({ mode: 'flag' });
  });

  it('rejects an invalid mode with 400 and does not persist it', async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const putResponse = await request(app)
      .put('/admin/translation-flag-display')
      .set('x-admin-passcode', 'test-passcode')
      .send({ mode: 'delete-everything' });
    expect(putResponse.status).toBe(400);

    const getResponse = await request(app)
      .get('/admin/translation-flag-display')
      .set('x-admin-passcode', 'test-passcode');
    expect(getResponse.body).toEqual(DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: FAIL — `AppDeps` doesn't accept the new field yet, and the routes don't exist.

- [ ] **Step 3: Update `app.ts`**

Add this import to `server/src/app.ts`, alongside the existing config-store imports:

```ts
import {
  validateTranslationFlagDisplayConfig,
  type TranslationFlagDisplayStore,
} from './translationFlagDisplayStore.js';
```

Add the field to `AppDeps` (after `promptConfigStore: PromptConfigStore;`):

```ts
  translationFlagDisplayStore: TranslationFlagDisplayStore;
```

Add these two routes, after the existing `PUT /admin/prompt-config` route and before `return app;`:

```ts
  app.get('/admin/translation-flag-display', adminAuth, async (_req, res) => {
    res.json(await deps.translationFlagDisplayStore.read());
  });

  app.put('/admin/translation-flag-display', adminAuth, async (req, res) => {
    const config = validateTranslationFlagDisplayConfig(req.body);
    if (!config) {
      res.status(400).json({ error: 'Invalid translation flag display config: mode must be "hide" or "flag"' });
      return;
    }
    await deps.translationFlagDisplayStore.write(config);
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Run `app.test.ts`**

Run: `cd server && npx vitest run tests/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the new store into `index.ts`**

Edit `server/src/index.ts`. Add the import, alongside the existing config-store imports:

```ts
import { createTranslationFlagDisplayStore } from './translationFlagDisplayStore.js';
```

Add the store construction, after the line constructing `promptConfigStore`:

```ts
const translationFlagDisplayStore = createTranslationFlagDisplayStore(
  process.env.TRANSLATION_FLAG_DISPLAY_FILE_PATH ?? 'data/translation-flag-display.json'
);
```

Add `translationFlagDisplayStore` to the `createApp({...})` call:

```ts
const app = createApp({
  sermonDocStore,
  feedbackStore,
  viewerFeedbackStore,
  session,
  modelConfigStore,
  promptConfigStore,
  translationFlagDisplayStore,
  adminPasscode: process.env.ADMIN_PASSCODE,
});
```

Add `translationFlagDisplayStore` to the `attachWsServer({...})` call:

```ts
attachWsServer({
  httpServer,
  session,
  geminiClient,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
  createDeepgramConnection,
  sermonDocStore,
  feedbackStore,
  costTracker,
  modelConfigStore,
  promptConfigStore,
  translationFlagDisplayStore,
});
```

- [ ] **Step 6: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/tests/app.test.ts
git commit -m "Add passcode-gated /admin/translation-flag-display route"
```

---

### Task 5: Admin frontend — third section

**Files:**
- Modify: `web/app/admin/page.tsx`

**Interfaces:**
- Consumes: `GET/PUT /admin/translation-flag-display` (Task 4).

No frontend test framework exists in this repo — verification for this task is manual only, matching Task 9 of the pluggable-LLM-admin-config feature and the rest of `web/`.

- [ ] **Step 1: Add the new type, state, load, and save logic**

Edit `web/app/admin/page.tsx`. Add this type after the existing `PromptConfig` interface:

```ts
type TranslationFlagDisplayMode = 'hide' | 'flag';

interface TranslationFlagDisplayConfig {
  mode: TranslationFlagDisplayMode;
}
```

Add this state, after the existing `notesError` state declaration:

```ts
  const [displayConfig, setDisplayConfig] = useState<TranslationFlagDisplayConfig | null>(null);
  const [displaySaveStatus, setDisplaySaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [displayError, setDisplayError] = useState<string | null>(null);
```

Replace the `loadAll` function's body to also fetch and store the display config:

```ts
  async function loadAll(candidatePasscode: string) {
    setCheckingAuth(true);
    setAuthError(null);
    try {
      const [modelResponse, promptResponse, displayResponse] = await Promise.all([
        fetch(`${API_URL}/admin/model-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/prompt-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/translation-flag-display`, { headers: { 'x-admin-passcode': candidatePasscode } }),
      ]);

      if (modelResponse.status === 401 || promptResponse.status === 401 || displayResponse.status === 401) {
        window.sessionStorage.removeItem('adminPasscode');
        setAuthorized(false);
        setAuthError('Incorrect passcode.');
        return;
      }

      setModelConfig(await modelResponse.json());
      const promptData = await promptResponse.json();
      setNotes(promptData.notes);
      setFixedRules(promptData.fixedRules);
      setDisplayConfig(await displayResponse.json());

      window.sessionStorage.setItem('adminPasscode', candidatePasscode);
      setPasscode(candidatePasscode);
      setAuthorized(true);
    } catch {
      setAuthError('Could not reach the server. Check your connection and try again.');
    } finally {
      setCheckingAuth(false);
    }
  }
```

Add this function, after the existing `saveNotes` function:

```ts
  async function saveDisplayConfig() {
    if (!displayConfig) return;
    setDisplaySaveStatus('saving');
    setDisplayError(null);
    try {
      const response = await fetch(`${API_URL}/admin/translation-flag-display`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(displayConfig),
      });
      if (!response.ok) {
        setDisplayError(`Save failed (status ${response.status}).`);
        setDisplaySaveStatus('idle');
        return;
      }
      setDisplaySaveStatus('saved');
    } catch {
      setDisplayError('Save failed. Check your connection and try again.');
      setDisplaySaveStatus('idle');
    }
  }
```

- [ ] **Step 2: Add the new section to the JSX**

Add this block after the "Prompt notes" `<div>` closes and before the closing `</main>`:

```tsx
      <div className="w-full max-w-xl flex flex-col gap-3">
        <h2 className="text-lg font-medium">Unsafe translation display</h2>
        {displayConfig && (
          <div className="flex flex-col gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="translationFlagDisplayMode"
                checked={displayConfig.mode === 'hide'}
                onChange={() => {
                  setDisplayConfig({ mode: 'hide' });
                  setDisplaySaveStatus('idle');
                }}
              />
              Hide (fallback to English)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="translationFlagDisplayMode"
                checked={displayConfig.mode === 'flag'}
                onChange={() => {
                  setDisplayConfig({ mode: 'flag' });
                  setDisplaySaveStatus('idle');
                }}
              />
              Show in viewer, marked red, with reason
            </label>
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={saveDisplayConfig}
            disabled={displaySaveStatus === 'saving'}
            className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
          >
            Save display setting
          </button>
          {displaySaveStatus === 'saved' && <p className="text-sm text-green-600">Saved.</p>}
        </div>
        {displayError && <p className="text-sm text-destructive">{displayError}</p>}
      </div>
```

- [ ] **Step 3: Verify it compiles**

Run: `cd web && npx tsc -p tsconfig.json --noEmit`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add web/app/admin/page.tsx
git commit -m "Add unsafe-translation display toggle to the admin page"
```

---

### Task 6: Viewer frontend — show flagged translations

**Files:**
- Modify: `web/lib/useViewerSocket.ts`
- Modify: `web/app/view/page.tsx`

**Interfaces:**
- Consumes: `flagged`/`reason` fields on `caption`, `caption-inserted`, and `backlog` messages (Task 3).

No frontend test framework exists in this repo — verification for this task is manual only.

- [ ] **Step 1: Update `CaptionLine` and message handling in `useViewerSocket.ts`**

Edit `web/lib/useViewerSocket.ts`. Replace the `CaptionLine` interface:

```ts
export interface CaptionLine {
  id: string;
  english: string;
  translated: string;
  removed?: boolean;
  flagged?: boolean;
  reason?: string;
}
```

Replace the `'caption'` branch in `socket.onmessage`:

```ts
        } else if (message.type === 'caption') {
          setLines((previous) => [
            ...previous,
            {
              id: message.id,
              english: message.english,
              translated: message.translated,
              ...(message.flagged ? { flagged: true, reason: message.reason } : {}),
            },
          ]);
          setStatus('live');
        }
```

Replace the `'caption-inserted'` branch:

```ts
        } else if (message.type === 'caption-inserted') {
          setLines((previous) => {
            const index = previous.findIndex((line) => line.id === message.id);
            const inserted = {
              id: message.id,
              english: message.english,
              translated: message.translated,
              ...(message.flagged ? { flagged: true, reason: message.reason } : {}),
            };
            if (index === -1) return [...previous, inserted];
            const next = [...previous];
            next[index] = inserted;
            return next;
          });
          setStatus('live');
        }
```

The `'backlog'` branch (`setLines(message.lines);`) needs no change — the server now sends each backlog line already shaped with `flagged`/`reason` when applicable, so it passes through as-is.

- [ ] **Step 2: Style flagged lines in `view/page.tsx`**

Edit `web/app/view/page.tsx`. Replace the non-removed line rendering block:

```tsx
            <div key={line.id} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground">{line.english}</p>
                <p className="text-xl">{line.translated}</p>
              </div>
              {renderLineFeedback(index, line)}
            </div>
```

with:

```tsx
            <div key={line.id} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground">{line.english}</p>
                <p className={`text-xl ${line.flagged ? 'text-rose-600 dark:text-rose-400' : ''}`}>{line.translated}</p>
                {line.flagged && line.reason && (
                  <p className="text-xs text-rose-600/80 dark:text-rose-400/80">{line.reason}</p>
                )}
              </div>
              {renderLineFeedback(index, line)}
            </div>
```

- [ ] **Step 3: Verify it compiles**

Run: `cd web && npx tsc -p tsconfig.json --noEmit`
Expected: no output, exit 0.

- [ ] **Step 4: Manual verification**

1. In `server/.env`, ensure `ADMIN_PASSCODE` is set, then start the server (`cd server && npm run dev`) and web app (`cd web && npm run dev`).
2. Open `/admin`, enter the passcode, switch "Unsafe translation display" to "Show in viewer, marked red, with reason", click "Save display setting".
3. Start a capture session (this is required for the new mode to take effect — it's read fresh at Start).
4. From a viewer tab subscribed to any language, confirm a translation the verifier flags shows in rose-red with the reason text beneath it, instead of silently falling back to English.
5. Refresh the viewer tab (or open a second viewer tab for the same language) — confirm the flagged line and its reason still show correctly from the backlog.
6. Switch the admin toggle back to "Hide", start a new session, and confirm the same scenario now falls back to English with no colored text and no reason shown — matching pre-feature behavior.

- [ ] **Step 5: Commit**

```bash
git add web/lib/useViewerSocket.ts web/app/view/page.tsx
git commit -m "Show flagged translations in the viewer in rose-red with the verifier's reason"
```

---

## Final Verification

- [ ] Run `cd server && npx vitest run` — full suite green.
- [ ] Run `cd server && npx tsc -p tsconfig.json --noEmit` — no type errors.
- [ ] Run `cd web && npx tsc -p tsconfig.json --noEmit` — no type errors.
- [ ] Complete the manual verification in Task 6 Step 4.
- [ ] Confirm a normal (non-toggled) capture session still behaves exactly as before this feature — no `flagged`/`reason` fields anywhere on the wire, no visual change in the viewer.
