# Unsafe-Translation Display Toggle — Design

## Purpose

Today, when [translationVerifier.ts](../../../server/src/translationVerifier.ts) flags a translation as unsafe, [wsServer.ts](../../../server/src/wsServer.ts)'s `finishPublishing`/`ensureBacklogCached` silently fall back to the English text — viewers never see the actual (possibly-fine, possibly-wrong) translation, and nobody ever finds out the verifier flagged something. That's the right default for a live service, but it means nobody can tell how often the verifier is firing, or review its judgment.

This design adds an admin-configurable display mode: for testing, an admin can switch from "hide" (today's behavior) to "flag" — viewers then see the actual translated text, visually marked as flagged, with the verifier's reason attached, so native speakers can review the verifier's calls directly instead of never seeing them.

## Scope

- A new persisted, admin-editable setting: `hide` (default, today's behavior) vs `flag` (show flagged translations in the viewer, marked red, with reason).
- Extends `TranslationCache` to remember flag/reason per line/language, so a viewer who joins or refreshes later still sees it — not just the viewer watching live.
- New admin route pair (`GET/PUT /admin/translation-flag-display`) and a third section on the `/admin` page.
- Viewer-facing message/type changes to carry the flag/reason, and viewer-page styling for flagged lines.
- Explicitly out of scope: applying the toggle live to an already-running session (it's read once at session Start, same as model/prompt config); per-language toggles (one global setting for all languages); showing flag/reason on the capture page (this is a viewer-facing feature only — the capture page's transcription-flag UI is unrelated and untouched).

## Design

### 1. New config store

New `server/src/translationFlagDisplayStore.ts`, following the exact `modelConfigStore.ts`/`promptConfigStore.ts` pattern:

```ts
export type TranslationFlagDisplayMode = 'hide' | 'flag';
export interface TranslationFlagDisplayConfig { mode: TranslationFlagDisplayMode; }
export const DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG: TranslationFlagDisplayConfig = { mode: 'hide' };
```

Persisted to `server/data/translation-flag-display.json`. `validateTranslationFlagDisplayConfig` rejects anything whose `mode` isn't exactly `'hide'` or `'flag'`. Default is `'hide'` — shipping this changes nothing about today's viewer-facing behavior until an admin explicitly switches it.

### 2. `TranslationCache` gains flag/reason

`server/src/translationCache.ts` currently stores `Map<language, Map<lineId, string>>`. It becomes `Map<language, Map<lineId, CachedTranslation>>` where:

```ts
export interface CachedTranslation {
  translated: string;
  flagged: boolean;
  reason?: string;
}
```

`get`/`set` signatures update accordingly (`set(language, lineId, entry: CachedTranslation)`). In `'hide'` mode every entry is `{ translated, flagged: false }` — identical information to what's stored today, just wrapped. In `'flag'` mode, an unsafe translation is stored as `{ translated: <the actual translation>, flagged: true, reason: verification.reason }`.

### 3. `wsServer.ts`: branch once per publish, not per viewer

Both `finishPublishing` and `ensureBacklogCached` currently compute `const outgoing = safe ? translated : line.english;` per language. This becomes mode-dependent, read once per session from `translationFlagDisplayStore` at Start (alongside model/prompt config) and stored on `Session` (e.g. `session.translationFlagDisplayMode: TranslationFlagDisplayMode`, defaulting to `'hide'`, reset in `Session.start()`):

- **`'hide'`** (default): unchanged — `outgoing = safe ? translated : line.english`; cached as `{ translated: outgoing, flagged: false }`.
- **`'flag'`**: `outgoing = translated` always (never substitutes English); cached as `{ translated, flagged: !safe, reason: safe ? undefined : verification.reason }`.

The viewer-facing WebSocket messages (`caption`, `caption-inserted`, and each line inside a `backlog` payload) gain optional `flagged`/`reason` fields, included only when `flagged` is true. In `'hide'` mode no line ever carries these fields, so the wire format is byte-identical to today — existing viewer clients (or anyone inspecting the protocol) see no difference unless an admin has switched modes.

### 4. Admin routes

`GET /admin/translation-flag-display` → `{ mode }`. `PUT /admin/translation-flag-display` → validates and persists, 400 on an invalid `mode`. Both gated by the existing `adminAuth` middleware, matching the other two admin route pairs exactly.

### 5. Viewer frontend

`CaptionLine` in `web/lib/useViewerSocket.ts` gains `flagged?: boolean; reason?: string`, populated from the `caption`/`caption-inserted`/`backlog` messages exactly as those fields arrive (no client-side re-derivation). In `web/app/view/page.tsx`, the translated-text `<p>` for a line with `flagged: true` uses `text-rose-600 dark:text-rose-400` instead of the default `text-xl` styling's implicit foreground color, and a `text-xs text-rose-600/80 dark:text-rose-400/80` line renders underneath showing `line.reason` — visually distinct from the app's existing `text-destructive` (used for unrelated error states like failed PDF export or failed feedback submission), so a flagged translation is never confused with an app error.

### 6. Admin page

A third section on `web/app/admin/page.tsx`, "Unsafe translation display", with two radio options (`hide` / `flag`) and the same load/edit/save/status pattern as the existing "Models" and "Prompt notes" sections — `GET` on page load, local state on selection, `PUT` + "Saved."/error handling on save.

## Error Handling

- **Invalid `mode` in `PUT /admin/translation-flag-display`** → 400, prior persisted value untouched (matches the other two admin PUT routes).
- **Config file missing/corrupt** → falls back to `DEFAULT_TRANSLATION_FLAG_DISPLAY_CONFIG` (`'hide'`), same posture as `modelConfigStore`/`promptConfigStore`.
- **Mode changed mid-service** → no effect on the in-flight session; applies starting the next Start (consistent with model/prompt config's existing behavior and rationale — avoids races with in-flight publishes).

## Testing

- **Unit**: `translationFlagDisplayStore` read/write/validate — mirrors `modelConfigStore.test.ts`'s test shape exactly.
- **Unit**: `TranslationCache` — `get`/`set` round-trip the full `CachedTranslation` shape, including `flagged`/`reason`.
- **Unit**: `app.test.ts` — `GET/PUT /admin/translation-flag-display`, 401 without passcode, 400 on invalid mode, round-trip persistence.
- **Integration** (`wsServer.test.ts`): in `'hide'` mode, an unsafe translation still falls back to English with no `flagged` field on the wire (regression guard — today's behavior unchanged by default). In `'flag'` mode, an unsafe translation is delivered as-is with `flagged: true` and the verifier's `reason`, both on the live `caption` message and in a later viewer's `backlog` entry for the same line.
- **Manual**: toggle to `'flag'` via `/admin`, start a session, trigger a translation the verifier flags, confirm the viewer page shows it in rose-red with the reason text beneath; toggle back to `'hide'` and confirm the same scenario falls back to English with no visual marker, matching pre-feature behavior.
- **Out of scope**: whether the verifier's flagging judgment itself is accurate — that's model behavior, not something this codebase unit-tests, consistent with the existing test suite's stance.

## Future Extensions (explicitly out of scope now)

- Applying the toggle live to an already-running session without a restart.
- Per-language display mode (e.g. flag only for languages under active QA).
- Surfacing flagged-translation stats/counts anywhere (e.g. an admin dashboard of how often the verifier fires) — this design only makes individual flagged lines visible to viewers, it doesn't aggregate them.
