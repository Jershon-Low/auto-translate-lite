# Web UI Style Guide

Written after the 2026-07-18 redesign (see `docs/superpowers/specs/2026-07-18-web-ux-redesign-design.md` and `docs/superpowers/plans/2026-07-18-web-ux-redesign.md` for full rationale and history). Read this before making UI changes in `web/app/` or `web/components/`.

## Accent color

One restrained accent — blue — lives entirely in three tokens in `web/app/globals.css`: `--primary`, `--ring`, and `--chart-1` (light block under `:root`, dark block under `.dark`). Everything else stays on the `neutral` shadcn base color. Don't add a second accent color or override `bg-primary`/`ring`/`text-primary` with a raw color anywhere else — if the accent needs to change (e.g. a real church brand color arrives), change it in exactly those two places in `globals.css` and every button/badge/focus-ring in the app updates automatically.

If the accent hue changes in the future, also re-check `--primary-foreground`'s contrast in both the `:root` and `.dark` blocks — don't just swap the hue and move on. The dark-mode `--primary-foreground` was specifically flipped from dark to near-white text during this redesign to stay readable against the new lighter blue `--primary`; a different hue can just as easily flip which foreground color reads correctly.

The app currently forces dark mode: `web/app/layout.tsx` hardcodes `className="dark ..."` on `<html>` and there is no theme toggle. Both light and dark token blocks exist in `globals.css` (shadcn always ships both), but only the dark block is ever actually rendered today — verify visual changes in dark mode.

## Split-persona layout principle

This app has two very different kinds of pages, and they're styled differently on purpose:

- **Audience-facing** (`app/page.tsx` landing, `app/view/page.tsx` viewer) — read by a congregant on their own phone, often at a glance. Large type, minimal chrome, generous spacing. Prefer plain, big, obviously-tappable controls over dense controls.
- **Operator-facing** (`app/capture/page.tsx`, `app/admin/page.tsx`) — used by one person on a laptop who needs everything organized, not glanceable. These use `Tabs` to split a page into sections (Live/Feedback notes/Viewer feedback on capture; Models/Prompt notes/Display on admin) instead of one long scrolling column, and a sticky header on the capture page keeps Start/Stop/status visible regardless of which tab or scroll position you're at.

When adding a new page or a large new section, decide which persona it serves before picking a layout — don't default to "one long column" for operator tools, and don't default to dense tabs/dashboards for anything a congregant reads on their phone.

## Component patterns established here

- **Status/"live" indicator**: a `Badge` with a `<span className="size-2 animate-pulse rounded-full bg-primary-foreground" />` dot, using the default (solid primary) `Badge` variant. Used identically on the viewer page and the capture page. Don't invent a second visual style for "is this live right now" — reuse this pattern.
- **Non-disruptive inline actions** (e.g. flagging a caption line on the viewer page): use `Popover` anchored to an icon `Button`, not an element that expands inline and reflows surrounding content. Reach for this whenever a small, secondary action would otherwise shift nearby content that someone might be mid-way through reading.
- **Save confirmations**: `toast()` from `sonner` (host mounted once in `web/app/layout.tsx` as `<Toaster theme="dark" />`), not inline "Saved."/error text that permanently occupies layout space. Exception: errors tied to a specific, still-visible field (e.g. the capture page's sermon-doc upload error, or a per-line reinstate/remove error in the transcript) stay as inline text next to that field — they're contextual, not a transient one-off confirmation, so a toast that disappears would be the wrong fit. The viewer page's PDF-export error (`exportError` in `web/app/view/page.tsx`) is the same kind of exception: it stays inline rather than becoming a toast because it's tied to the always-visible Download button, not a one-off action confirmation.
- **Multi-choice pickers**: `Select` for open-ended/long option lists (e.g. OpenRouter model ids), `ToggleGroup` for a small fixed set of mutually exclusive options (e.g. reasoning effort: off/low/medium/high; capture mode: automatic/manual), `RadioGroup` for a small fixed set presented as a form choice (e.g. admin's hide/flag display setting). Don't reach for a native `<select>` or raw `<input type="radio">` — every one of these has a shadcn component now.
- **Scroll containers**: use `ScrollArea` for any scrollable list that never needs programmatic scroll-position reads (e.g. the capture page's pending-approval queue and viewer-feedback list). Keep a plain `overflow-y-auto` div with a `ref` when the container needs `scrollTop`/`scrollHeight` reads for auto-follow/jump-to-latest behavior (the viewer page's caption container, the capture page's transcript panel) — shadcn's `ScrollArea` doesn't expose its internal scrollable viewport as a plain ref target, so don't force it there.
- **Base library, not Radix**: this project's shadcn style (`base-nova`) is backed by `@base-ui/react`, not Radix — confirmed by `web/components/ui/button.tsx`. Custom triggers use the `render` prop (e.g. `<PopoverTrigger render={<Button>...</Button>} />`), not `asChild`.
- **`ToggleGroup` API gotcha**: unlike Radix's `ToggleGroup`, this project's `ToggleGroup` (`web/components/ui/toggle-group.tsx`, wrapping `@base-ui/react/toggle-group`) has no `type="single"` prop. Its real API is an array-valued `value`/`onValueChange` with a `multiple` flag that defaults to `false`. For a single-select toggle group, pass `value={[current]}` and derive the new value from `values[0]` inside `onValueChange` — see `web/app/capture/page.tsx` (capture mode) and `web/app/admin/page.tsx` (reasoning effort) for the established pattern. Don't guess at a Radix-style `type`/`value` (string) signature here.

## Adding new shadcn components

Check `web/components/ui/` before running `npx shadcn@latest add <name>` — don't re-add an already-installed component. Run `npx shadcn@latest docs <name>` and read the fetched docs before using an unfamiliar component's props; don't guess at prop names from memory or from a similar-looking library.
