# Web UX Redesign

## Problem

The four pages in `web/app/` (`page.tsx` landing, `view/page.tsx` viewer, `capture/page.tsx` capture, `admin/page.tsx` admin) are functionally complete but visually unfinished: almost everything is raw Tailwind on native `<div>`/`<select>`/`<input>` elements rather than shadcn components (only `Button` and `Card` are actually installed), the theme is pure grayscale with no accent color, and each page's layout doesn't reflect how differently it's actually used — a congregant glancing at captions on their phone, an AV operator running a live board on a laptop, and an admin doing occasional config all get the same "stack everything in one column" treatment.

## Goals

- Give audience-facing pages (landing, viewer) a large-type, glanceable, phone-first treatment.
- Give operator-facing pages (capture, admin) a proper dense dashboard treatment (tabs, always-visible status) instead of one long scrolling column.
- Introduce one restrained accent color (blue) for "live" status and primary actions; everything else stays neutral gray.
- Replace raw markup with real shadcn components throughout.
- Preserve dark mode (already wired via semantic tokens — must keep working, not be redone).
- No new dependencies beyond shadcn components + lucide icons (already-configured icon library).
- Ship a style guide document at the end, so future sessions (human or Claude) can extend the UI consistently without re-deriving these decisions.

## Non-goals

- No functional/behavioral changes to any page — this is visual/structural only. Every existing interaction (start/stop capture, approve/reject queue, keyboard shortcuts, feedback flows, admin model config, PDF export, viewer language switch) must keep working exactly as before.
- No real brand identity work (logo, church-specific colors) — the accent is a placeholder blue, swappable later.
- No backend/API changes.

## Design

### Shared design system

- `web/app/globals.css`: retint `--primary`, `--ring`, and `--chart-1` to a blue hue (light: `oklch(0.55 0.18 258)`; dark: a lighter/desaturated variant of the same hue such as `oklch(0.65 0.19 258)`; `--primary-foreground` stays nearly white/black as needed for contrast). `baseColor` stays `neutral` — no other token changes. This keeps every existing `bg-primary`/`text-primary-foreground`/`ring` usage automatically re-colored with no per-component edits.
- A shared "Live" indicator treatment: a `Badge` with a small pulsing dot (CSS animation, no new dependency) in the accent color, used identically on the viewer page and the capture page. Non-live states (`Connecting…`, `Reconnecting…`) use a muted `Badge` + `Spinner`, not the dot.
- New shadcn components to add (via `npx shadcn@latest add`): `select`, `tabs`, `badge`, `alert`, `field`, `toggle-group`, `radio-group`, `textarea`, `input`, `separator`, `scroll-area`, `popover`, `sonner`, `spinner`. Check `components/ui/` before adding — don't re-add `button`/`card`.
- All destructive/save-status UX keeps its current *behavior* (confirm-before-destructive stays as-is unless noted below); only the *presentation* changes (toasts instead of inline "Saved." text, `Badge`/`Alert` instead of raw colored `<p>` tags).

### Landing page (`app/page.tsx`)

- Heading grows to a larger size; add one line of subtext under it (e.g. "Live captions for today's service").
- Language options become larger `Card`s in the existing 2-column grid: bigger min-height for easier tapping, centered icon (generic globe/language lucide icon) + label, accent-colored hover/active ring instead of the current plain `hover:bg-accent`.
- No change to the language-selection logic (localStorage save + redirect to `/view?lang=`).

### Viewer page (`app/view/page.tsx`)

This is the page most likely to be read on a phone mid-service, so it gets the most scrutiny:

- Status text (`Connecting…` / `Reconnecting…` / `Live`) becomes a `Badge`: pulsing-dot accent badge for "Live", muted badge + `Spinner` for the connecting/reconnecting states.
- "Download Transcript (PDF)" and "Change language" become icon `Button`s (`Download`, `Globe` from lucide) instead of underlined text links — bigger tap targets, same actions, same disabled-while-exporting behavior.
- Translated line gets a larger font size on small viewports; the muted English original above it stays as-is (this original-above-translation pattern is a good trust mechanism and is not being changed).
- The flag (⚑) button becomes an icon `Button` (`Flag` from lucide). Its comment box currently expands inline in the caption flow (pushing the layout down); it moves into a `Popover` anchored to the flag button instead, so flagging a line doesn't shift the other lines a reader might be tracking. Same submit/cancel/error states, just presented in the popover instead of inline.
- "Jump to latest" floating button and the bottom disclaimer bar keep their exact current logic/positioning; only their visual presentation (icon-augmented `Button`, `Alert`-style disclaimer, icon-`Button` dismiss) changes.

### Capture page (`app/capture/page.tsx`)

Currently one long scrolling column of ~6 stacked sections. Restructured into:

- **Sticky header** (always visible, no scrolling required): Start/Stop `Button`s, a status `Badge` (idle/recording/reconnecting/error, using the same accent "Live" dot pattern when recording), the session/lifetime cost line, and the sermon-document upload control.
- **`Tabs` below the header**, replacing the rest of the stacked sections:
  - **Live** (default tab) — mode toggle as a `ToggleGroup` (Automatic/Manual) instead of underline-styled buttons; the pending-approval queue; the running transcript. This is the tab an operator lives in during a service.
  - **Feedback notes** — the existing free-text notes textarea + save, as its own tab (reviewed before/after a service, not mid-service).
  - **Viewer feedback** — the existing flagged-line feedback list + per-item/bulk download, as its own tab.
- The keyboard-shortcut rebinding UI (currently an always-visible row) moves into a small `Popover` labeled "Shortcuts"; the currently-bound keys still show inline next to the Approve/Reject buttons as small badges so the shortcuts stay discoverable without permanently occupying screen space.
- Transcript and pending-queue panels use `Card` + `ScrollArea` instead of raw `overflow-y-auto` divs. Inline "Saved."/error `<p>` feedback is replaced by `sonner` toasts (save/upload/download success and failure).
- All existing behavior is preserved exactly: `window.confirm` before destructive actions (remove line, reject after send, clearing feedback notes) stays as native `confirm()` — this spec does not migrate those to `AlertDialog`, to keep the change scoped to layout/components rather than interaction redesign. Keyboard shortcuts (approve/reject key rebinding, Enter/Space defaults) work identically.

### Admin page (`app/admin/page.tsx`)

- Passcode gate becomes a centered `Card` with a lock-icon `Input` and an `Alert` for the incorrect-passcode error, same auth logic.
- The three stacked sections (Models / Prompt notes / Unsafe translation display) become `Tabs`. Each tab keeps its own independent Save button and save-status handling exactly as today (three separate save actions, three separate loading/error states) — just presented via toast instead of inline text.
- **Models tab**: each role (`transcriptionVerifier`/`translation`/`translationVerifier`) becomes a `Card` containing real `Select`s for provider and model (replacing native `<select>`), and for OpenRouter, the reasoning-effort picker (`off`/`low`/`medium`/`high`) becomes a `ToggleGroup` instead of a `<select>` since it's 4 mutually exclusive options — same underlying state and save behavior.
- **Prompt notes tab**: fixed rules shown as a muted `Alert`/read-only block instead of a plain `<p>`; editable notes stay a `Textarea` per role.
- **Display tab**: the hide/flag choice becomes a `RadioGroup` instead of raw `<input type="radio">`.

### Style guide deliverable

Once all four pages are implemented, write `web/docs/STYLE_GUIDE.md` covering: the accent-color rationale and token locations, the split-persona layout principle (audience pages vs. operator pages) and when to apply each, the list of shadcn components in use and the patterns established here (Tabs for multi-section operator pages, Popover for non-disruptive inline actions, Badge for live/status indicators, sonner for save confirmations), and a pointer to this spec for full context. Add a one-line reference to it from `web/AGENTS.md` so future sessions load it automatically the same way `AGENTS.md` is already loaded via `web/CLAUDE.md`.

## Testing

This is a UI-only change with no new business logic, so no new automated tests are required. Verification is manual/visual per page (light + dark mode, and mobile viewport for landing/viewer):

- Landing: language selection still redirects correctly and persists to localStorage.
- Viewer: status badge reflects connecting/reconnecting/live correctly; flag popover submits/cancels/shows errors identically to before; PDF export and language-change links still work; jump-to-latest and disclaimer dismiss still work.
- Capture: start/stop, automatic/manual mode toggle, approve/reject (both button and keyboard shortcut), shortcut rebinding, sermon doc upload, feedback notes save, viewer feedback list/download — all behave identically to pre-redesign, just in the new tabbed layout.
- Admin: passcode gate, all three tabs' save actions, OpenRouter model add flow — all behave identically to pre-redesign.

Existing `server` test suite (`cd server && npm test`) is unaffected since no server code changes.
