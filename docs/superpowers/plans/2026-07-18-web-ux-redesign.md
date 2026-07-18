# Web UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle all four pages in `web/app/` (landing, viewer, capture, admin) using real shadcn components, a single restrained blue accent color, and a "split persona" layout (large/glanceable for the two audience-facing pages, dense tabbed dashboards for the two operator-facing pages) — with zero change to existing behavior.

**Architecture:** Foundation task retints the theme and installs the needed shadcn components once; four independent page tasks each rewrite one `app/**/page.tsx` file end-to-end (same state, same handlers, same WebSocket/fetch logic — only the JSX and a few save-confirmation code paths change); a final task documents the resulting system as a style guide for future sessions.

**Tech Stack:** Next.js 16 (App Router) + React 19, Tailwind v4, shadcn (`base-nova` style, `@base-ui/react` primitives, `lucide-react` icons), `sonner` for toasts.

## Global Constraints

- Visual/structural only — every existing interaction (start/stop capture, automatic/manual mode, approve/reject incl. keyboard shortcuts, shortcut rebinding, sermon doc upload, feedback notes save, viewer feedback list/download, admin model/prompt/display config, PDF export, viewer language switch) must keep working exactly as before.
- No new dependencies beyond shadcn-installed components + `lucide-react` icons already in the project. `npx shadcn@latest add sonner` will pull in `next-themes` as a registry-declared peer dependency — that's expected and not scope creep.
- Accent color is blue, introduced **only** via `--primary`, `--ring`, and `--chart-1` in `web/app/globals.css`. Do not touch any other token. `baseColor` stays `neutral`.
- `web/app/layout.tsx` currently hardcodes `className="dark ..."` on `<html>` — this app never renders in light mode today. There is no theme toggle. Preserve this; do not add one. All manual verification should be done in this (the only) rendered mode.
- Package manager is npm (`web/package-lock.json` present). Run all commands from the `web/` directory.
- The project's shadcn style is `base-nova`, backed by `@base-ui/react` (confirmed by `web/components/ui/button.tsx` importing `Button as ButtonPrimitive` from `@base-ui/react/button`) — **not** Radix. Custom triggers use the `render` prop (e.g. `<PopoverTrigger render={<Button>...</Button>} />`), not `asChild`.
- There is no component test harness in this repo (no Jest/RTL in `web/package.json`). The verification step for every task is `npm run build` (Next.js type-checks on build — see `web/next.config.ts`, no `ignoreBuildErrors` override) plus a manual check in the dev server against the checklist in each task.

---

### Task 1: Foundation — accent color, shadcn components, toast host

**Files:**
- Modify: `web/app/globals.css:51-118` (retint tokens)
- Modify: `web/app/layout.tsx` (mount `Toaster`)
- Create (via CLI): `web/components/ui/select.tsx`, `tabs.tsx`, `badge.tsx`, `alert.tsx`, `field.tsx`, `toggle-group.tsx`, `radio-group.tsx`, `textarea.tsx`, `input.tsx`, `separator.tsx`, `scroll-area.tsx`, `popover.tsx`, `sonner.tsx`, `spinner.tsx`

**Interfaces:**
- Produces: retinted `--primary`/`--ring`/`--chart-1` tokens used by every later task's `bg-primary`/`ring`/focus styles; the full shadcn component set under `@/components/ui/*` used by Tasks 2–5; a mounted `<Toaster theme="dark" />` so `toast()` from `"sonner"` works when called from any client component (used by Tasks 4–5).
- Consumes: nothing (first task).

- [ ] **Step 1: Install the shadcn components**

Run from `web/`:

```bash
npx shadcn@latest add select tabs badge alert field toggle-group radio-group textarea input separator scroll-area popover sonner spinner
```

- [ ] **Step 2: Verify the files were created**

```bash
ls web/components/ui
```

Expected: alongside the existing `button.tsx`/`card.tsx`, you now see `select.tsx`, `tabs.tsx`, `badge.tsx`, `alert.tsx`, `field.tsx`, `toggle-group.tsx`, `radio-group.tsx`, `textarea.tsx`, `input.tsx`, `separator.tsx`, `scroll-area.tsx`, `popover.tsx`, `sonner.tsx`, `spinner.tsx`. Also check `web/package.json` picked up `next-themes` as a new dependency (pulled in automatically by the `sonner` registry item).

- [ ] **Step 3: Skim the docs for the components with less obvious APIs**

```bash
npx shadcn@latest docs select tabs toggle-group radio-group popover
```

Fetch the returned URLs and confirm: `Select` takes `value`/`onValueChange` on the root and needs `SelectTrigger > SelectValue`, `SelectContent > SelectGroup > SelectItem`; `Tabs` takes `defaultValue` on the root, `TabsList > TabsTrigger`, sibling `TabsContent`; `ToggleGroup` takes `type="single"` + `value`/`onValueChange` wrapping `ToggleGroupItem`; `RadioGroup` takes `value`/`onValueChange` wrapping `RadioGroupItem`; `Popover` takes `open`/`onOpenChange` on the root with `PopoverTrigger` accepting a `render` prop for a custom trigger element and `PopoverContent` for the panel. If any fetched doc shows a different prop name than described here, use the fetched doc's actual prop name in Tasks 3–5 instead of what's written there — everything else in those tasks is unaffected by this kind of rename.

- [ ] **Step 4: Retint the theme tokens**

In `web/app/globals.css`, change these four lines under `:root`:

```css
  --primary: oklch(0.55 0.18 258);
  --primary-foreground: oklch(0.985 0 0);
  --ring: oklch(0.62 0.17 258);
  --chart-1: oklch(0.55 0.18 258);
```

(replacing the existing `--primary`, `--primary-foreground`, `--ring`, and `--chart-1` lines — leave `--chart-2` through `--chart-5` and every other variable untouched)

and these four lines under `.dark`:

```css
  --primary: oklch(0.62 0.19 258);
  --primary-foreground: oklch(0.985 0 0);
  --ring: oklch(0.62 0.19 258);
  --chart-1: oklch(0.62 0.19 258);
```

- [ ] **Step 5: Mount the toast host**

Replace `web/app/layout.tsx` with:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Auto Translate Lite",
  description: "Live sermon translation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster theme="dark" />
      </body>
    </html>
  );
}
```

(`theme="dark"` is hardcoded, matching the app's own hardcoded `dark` class above — there is no theme switching to react to.)

- [ ] **Step 6: Build to verify**

```bash
cd web && npm run build
```

Expected: build succeeds with no TypeScript errors. (Pages don't use the new components yet, so this mainly confirms the new `components/ui/*` files and the CSS/layout edits compile cleanly on their own.)

- [ ] **Step 7: Commit**

```bash
git add web/app/globals.css web/app/layout.tsx web/components/ui web/package.json web/package-lock.json
git commit -m "Add blue accent tokens, install shadcn components, mount toast host"
```

---

### Task 2: Landing page redesign

**Files:**
- Modify: `web/app/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `Card`/`CardContent` (existing), `Languages` icon from `lucide-react`, `TARGET_LANGUAGES` from `@/lib/languages` (all unchanged).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace `web/app/page.tsx`**

```tsx
'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Languages } from 'lucide-react';
import { TARGET_LANGUAGES } from '@/lib/languages';
import { Card, CardContent } from '@/components/ui/card';

const STORAGE_KEY = 'auto-translate-lite:language';

function LandingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (searchParams.get('reset') === '1') {
      window.localStorage.removeItem(STORAGE_KEY);
      setReady(true);
      return;
    }
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) {
      router.replace(`/view?lang=${saved}`);
    } else {
      setReady(true);
    }
  }, [router, searchParams]);

  function selectLanguage(code: string) {
    window.localStorage.setItem(STORAGE_KEY, code);
    router.push(`/view?lang=${code}`);
  }

  if (!ready) return null;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Choose your language</h1>
        <p className="text-muted-foreground">Live captions for today&apos;s service</p>
      </div>
      <div className="grid grid-cols-2 gap-4 w-full max-w-md">
        {TARGET_LANGUAGES.map((language) => (
          <Card
            key={language.code}
            className="cursor-pointer outline-none transition-colors hover:ring-2 hover:ring-primary focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => selectLanguage(language.code)}
          >
            <CardContent className="flex min-h-24 flex-col items-center justify-center gap-2 p-4 text-center">
              <Languages className="size-5 text-muted-foreground" aria-hidden="true" />
              <span className="text-lg font-medium">{language.label}</span>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}

export default function LandingPage() {
  return (
    <Suspense fallback={null}>
      <LandingPageContent />
    </Suspense>
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
cd web && npm run build
```

Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Manual check**

Run `npm run dev`, open `http://localhost:3000/?reset=1`. Confirm: heading + subtext render, the 12-language grid shows larger cards with a language icon, hovering a card shows a blue ring, clicking a card navigates to `/view?lang=<code>` and sets `localStorage['auto-translate-lite:language']`. Reload `http://localhost:3000/` (no `?reset=1`) and confirm it redirects straight to the previously chosen `/view?lang=` URL.

- [ ] **Step 4: Commit**

```bash
git add web/app/page.tsx
git commit -m "Redesign landing page with larger glanceable language cards"
```

---

### Task 3: Viewer page redesign

**Files:**
- Modify: `web/app/view/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `Button` (existing), `Badge`, `Popover`/`PopoverTrigger`/`PopoverContent`, `Textarea`, `Spinner` (from Task 1); `Download`/`Globe`/`Flag`/`ChevronDown`/`X` icons from `lucide-react`; `useViewerSocket`, `exportTranscriptPdf`, `TARGET_LANGUAGES`, `getFeedbackStrings`/`EN_FALLBACK` (all unchanged, from `@/lib/*`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace `web/app/view/page.tsx`**

```tsx
'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Download, Globe, Flag, ChevronDown, X } from 'lucide-react';
import { useViewerSocket, type ViewerStatus } from '@/lib/useViewerSocket';
import { exportTranscriptPdf } from '@/lib/exportTranscriptPdf';
import { TARGET_LANGUAGES } from '@/lib/languages';
import { getFeedbackStrings, EN_FALLBACK } from '@/lib/feedbackStrings';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

function StatusBadge({ status, hasLines }: { status: ViewerStatus; hasLines: boolean }) {
  if (status === 'connecting') {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <Spinner className="size-3" />
        Connecting…
      </Badge>
    );
  }
  if (status === 'reconnecting') {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <Spinner className="size-3" />
        Reconnecting…
      </Badge>
    );
  }
  if (!hasLines) {
    return <Badge variant="secondary">Waiting for the service to start…</Badge>;
  }
  return (
    <Badge className="gap-1.5">
      <span className="size-2 animate-pulse rounded-full bg-primary-foreground" />
      Live
    </Badge>
  );
}

function ViewerPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const language = searchParams.get('lang') ?? '';
  const { status, lines } = useViewerSocket(language, `${WS_URL}/ws/viewer`);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showDisclaimer, setShowDisclaimer] = useState(true);

  type LineFeedbackMode = 'idle' | 'open' | 'submitting' | 'submitted' | 'flagged' | 'error';
  interface LineFeedbackState {
    mode: LineFeedbackMode;
    comment: string;
  }
  const [feedbackByLine, setFeedbackByLine] = useState<Record<number, LineFeedbackState>>({});
  const flaggedTimeoutsRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const strings = getFeedbackStrings(language);

  useEffect(() => {
    if (!language) {
      router.replace('/');
    }
  }, [language, router]);

  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines]);

  useEffect(() => {
    return () => {
      Object.values(flaggedTimeoutsRef.current).forEach(clearTimeout);
    };
  }, []);

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom < 80;
    autoScrollRef.current = atBottom;
    setShowJumpButton(!atBottom);
  }

  function jumpToLatest() {
    autoScrollRef.current = true;
    setShowJumpButton(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  async function handleExportPdf() {
    setExportError(null);
    setIsExporting(true);
    try {
      const languageLabel =
        TARGET_LANGUAGES.find((entry) => entry.code === language)?.label ?? language;
      await exportTranscriptPdf(lines, language, languageLabel);
    } catch {
      setExportError("Couldn't generate PDF — try again");
    } finally {
      setIsExporting(false);
    }
  }

  function openFeedback(index: number) {
    setFeedbackByLine((previous) => ({
      ...previous,
      [index]: { mode: 'open', comment: previous[index]?.comment ?? '' },
    }));
  }

  function cancelFeedback(index: number) {
    setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'idle', comment: '' } }));
  }

  function updateFeedbackComment(index: number, comment: string) {
    setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'open', comment } }));
  }

  async function submitFeedback(index: number, line: { english: string; translated: string }, comment: string) {
    setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'submitting', comment } }));
    try {
      const response = await fetch(`${API_URL}/viewer-feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          lineIndex: index,
          english: line.english,
          translated: line.translated,
          comment,
        }),
      });
      if (!response.ok) throw new Error('request failed');
      setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'submitted', comment: '' } }));
      flaggedTimeoutsRef.current[index] = setTimeout(() => {
        setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'flagged', comment: '' } }));
      }, 2000);
    } catch {
      setFeedbackByLine((previous) => ({ ...previous, [index]: { mode: 'error', comment } }));
    }
  }

  function renderLineFeedback(index: number, line: { english: string; translated: string }) {
    const state = feedbackByLine[index] ?? { mode: 'idle' as const, comment: '' };

    if (state.mode === 'submitted') {
      return <span className="text-xs text-green-500 whitespace-nowrap">{strings.thanksConfirmation}</span>;
    }

    const isOpen = state.mode === 'open' || state.mode === 'submitting' || state.mode === 'error';

    return (
      <Popover open={isOpen} onOpenChange={(open) => (open ? openFeedback(index) : cancelFeedback(index))}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={state.mode === 'flagged' ? 'Flag this line again' : 'Flag this line'}
              className={state.mode === 'flagged' ? 'opacity-40' : undefined}
            >
              <Flag />
            </Button>
          }
        />
        <PopoverContent className="w-64" align="end">
          <div className="flex flex-col gap-2">
            <Textarea
              value={state.comment}
              onChange={(event) => updateFeedbackComment(index, event.target.value)}
              rows={2}
              placeholder={strings.flagPlaceholder}
              disabled={state.mode === 'submitting'}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void submitFeedback(index, line, state.comment)}
                disabled={state.mode === 'submitting'}
              >
                {strings.submit}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => cancelFeedback(index)}
                disabled={state.mode === 'submitting'}
              >
                {strings.cancel}
              </Button>
            </div>
            {state.mode === 'error' && <p className="text-xs text-destructive">{strings.submitError}</p>}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  if (!language) return null;

  return (
    <main className="h-dvh bg-background text-foreground flex flex-col">
      <div className="p-3 flex justify-between items-center border-b gap-2">
        <StatusBadge status={status} hasLines={lines.length > 0} />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={handleExportPdf} disabled={lines.length === 0 || isExporting}>
            {isExporting ? <Spinner className="size-3.5" data-icon="inline-start" /> : <Download data-icon="inline-start" />}
            {isExporting ? 'Generating…' : 'Download PDF'}
          </Button>
          <Button variant="ghost" size="sm" render={<a href="/?reset=1" />}>
            <Globe data-icon="inline-start" />
            Change language
          </Button>
        </div>
      </div>
      {exportError && <p className="px-3 pt-2 text-sm text-destructive">{exportError}</p>}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 sm:px-10 pt-4 pb-16 space-y-6"
      >
        {lines.map((line, index) =>
          line.removed ? (
            <div key={line.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex-1 border-t border-dashed" />
              <span>Line removed</span>
              <span className="flex-1 border-t border-dashed" />
            </div>
          ) : (
            <div key={line.id} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground">{line.english}</p>
                <p className={`text-xl sm:text-2xl ${line.flagged ? 'text-rose-400' : ''}`}>{line.translated}</p>
                {line.flagged && line.reason && <p className="text-xs text-rose-400/80">{line.reason}</p>}
              </div>
              {renderLineFeedback(index, line)}
            </div>
          )
        )}
        <div ref={bottomRef} />
      </div>
      {showJumpButton && (
        <Button
          onClick={jumpToLatest}
          size="sm"
          className={`fixed right-6 ${showDisclaimer ? 'bottom-28' : 'bottom-6'} rounded-full shadow-lg`}
        >
          <ChevronDown data-icon="inline-start" />
          Jump to latest
        </Button>
      )}
      {showDisclaimer && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t bg-background shadow-[0_-4px_12px_rgba(0,0,0,0.15)]">
          <div className="relative mx-auto flex max-w-3xl flex-col items-center justify-center px-6 sm:px-10 py-4 pr-10 text-xs text-muted-foreground gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowDisclaimer(false)}
              aria-label="Dismiss"
              className="absolute top-2 right-2"
            >
              <X />
            </Button>
            <p>{EN_FALLBACK.disclaimer}</p>
            {strings !== EN_FALLBACK && <p>{strings.disclaimer}</p>}
          </div>
        </div>
      )}
    </main>
  );
}

export default function ViewerPage() {
  return (
    <Suspense fallback={null}>
      <ViewerPageContent />
    </Suspense>
  );
}
```

- [ ] **Step 2: Export the `ViewerStatus` type used above**

Check `web/lib/useViewerSocket.ts:14` — it already declares `export type ViewerStatus = 'connecting' | 'reconnecting' | 'live';`, so the `import { useViewerSocket, type ViewerStatus } from '@/lib/useViewerSocket';` in Step 1 resolves as-is. No change needed to that file; this step is just a check, not an edit.

- [ ] **Step 3: Build to verify**

```bash
cd web && npm run build
```

Expected: succeeds with no TypeScript errors. If `PopoverTrigger`'s `render` prop doesn't type-check, re-check the docs fetched in Task 1 Step 3 and adjust only that prop name — the surrounding logic is unaffected.

- [ ] **Step 4: Manual check**

Run `npm run dev` and both `server` (per `README.md`'s local dev instructions) and the web app. Open `http://localhost:3000/view?lang=es` (or any configured language). Confirm: status badge shows "Connecting…" then a pulsing blue "Live" badge once captions arrive; original English stays small/muted above each larger translated line; clicking the flag icon opens a popover (not an inline reflow) with the comment box, Submit/Cancel work and show the same success/error text as before; "Jump to latest" and the dismissible disclaimer bar behave identically to before; "Download PDF" and "Change language" work.

- [ ] **Step 5: Commit**

```bash
git add web/app/view/page.tsx
git commit -m "Redesign viewer page: status badge, icon actions, non-disruptive flag popover"
```

---

### Task 4: Capture page redesign

**Files:**
- Modify: `web/app/capture/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `Button`, `Badge`, `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, `ToggleGroup`/`ToggleGroupItem`, `Popover`/`PopoverTrigger`/`PopoverContent`, `Textarea`, `ScrollArea`, `Alert`/`AlertDescription`, `toast` from `"sonner"` (from Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace `web/app/capture/page.tsx`**

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type CaptureStatus = 'idle' | 'recording' | 'reconnecting' | 'error';

type TranscriptLine = {
  id: string;
  text: string;
  flagged: boolean;
  reason?: string;
  pending?: boolean;
  dismissed?: boolean;
  reinstateState?: 'editing' | 'pending' | 'error';
  editedText?: string;
  reinstateError?: string;
  removeState?: 'pending' | 'error';
  removeError?: string;
};

interface ViewerFeedbackItem {
  id: string;
  sessionId: string;
  timestamp: string;
  language: string;
  lineIndex: number;
  english: string;
  translated: string;
  comment: string;
  downloaded: boolean;
}

function StatusBadge({ status }: { status: CaptureStatus }) {
  if (status === 'recording') {
    return (
      <Badge className="gap-1.5">
        <span className="size-2 animate-pulse rounded-full bg-primary-foreground" />
        Recording
      </Badge>
    );
  }
  if (status === 'reconnecting') {
    return <Badge variant="secondary">Reconnecting…</Badge>;
  }
  if (status === 'error') {
    return <Badge variant="destructive">Error</Badge>;
  }
  return <Badge variant="secondary">Idle</Badge>;
}

export default function CapturePage() {
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [sessionCostUsd, setSessionCostUsd] = useState(0);
  const [lifetimeCostUsd, setLifetimeCostUsd] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasUploadedDoc, setHasUploadedDoc] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSaveStatus, setFeedbackSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [viewerFeedback, setViewerFeedback] = useState<ViewerFeedbackItem[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const manuallyStoppedRef = useRef(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);

  const [mode, setModeState] = useState<'automatic' | 'manual'>('automatic');
  const modeRef = useRef<'automatic' | 'manual'>('automatic');

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  function setMode(newMode: 'automatic' | 'manual') {
    setModeState(newMode);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'set-mode', mode: newMode }));
    }
  }

  const pendingQueue = transcriptLines.filter((line) => line.pending && !line.dismissed);
  const undownloadedFeedbackCount = viewerFeedback.filter((item) => !item.downloaded).length;

  const [approveKey, setApproveKey] = useState('Enter');
  const [rejectKey, setRejectKey] = useState(' ');
  const [rebindingAction, setRebindingAction] = useState<'approve' | 'reject' | null>(null);
  const [rebindError, setRebindError] = useState<string | null>(null);

  useEffect(() => {
    const storedApprove = window.localStorage.getItem('captureApproveKey');
    const storedReject = window.localStorage.getItem('captureRejectKey');
    if (storedApprove) setApproveKey(storedApprove);
    if (storedReject) setRejectKey(storedReject);
  }, []);

  function displayKey(key: string): string {
    return key === ' ' ? 'Space' : key;
  }

  useEffect(() => {
    if (!rebindingAction) return;
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      const key = event.key;
      const otherKey = rebindingAction === 'approve' ? rejectKey : approveKey;
      if (key === otherKey) {
        setRebindError("Approve and Reject can't share a key.");
        return;
      }
      if (rebindingAction === 'approve') {
        setApproveKey(key);
        window.localStorage.setItem('captureApproveKey', key);
      } else {
        setRejectKey(key);
        window.localStorage.setItem('captureRejectKey', key);
      }
      setRebindError(null);
      setRebindingAction(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rebindingAction, approveKey, rejectKey]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (mode !== 'manual') return;
      if (rebindingAction) return;
      const target = event.target as HTMLElement | null;
      const isEditable = Boolean(
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      );
      if (isEditable) return;
      const oldest = pendingQueue[0];
      if (!oldest) return;
      if (event.key === approveKey) {
        event.preventDefault();
        sendReinstate(oldest.id);
      } else if (event.key === rejectKey) {
        event.preventDefault();
        rejectLine(oldest.id);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingQueue, approveKey, rejectKey, rebindingAction, mode]);

  useEffect(() => {
    fetch(`${API_URL}/feedback`)
      .then((response) => response.json())
      .then((data) => setFeedbackText(data.text ?? ''))
      .catch(() => setFeedbackText(''));
  }, []);

  useEffect(() => {
    void fetchViewerFeedback();
  }, []);

  async function fetchViewerFeedback() {
    try {
      const response = await fetch(`${API_URL}/viewer-feedback`);
      const data = await response.json();
      setViewerFeedback(Array.isArray(data.items) ? data.items : []);
    } catch {
      setViewerFeedback([]);
    }
  }

  useEffect(() => {
    const container = transcriptRef.current;
    if (container && isFollowing) container.scrollTop = container.scrollHeight;
  }, [transcriptLines, isFollowing]);

  function onTranscriptScroll() {
    const container = transcriptRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setIsFollowing(distanceFromBottom < 24);
  }

  function jumpToLatest() {
    const container = transcriptRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    setIsFollowing(true);
  }

  async function uploadSermonDoc(file: File) {
    setIsUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_URL}/sermon-doc`, { method: 'POST', body: formData });
      if (!response.ok) {
        let message = `Upload failed (status ${response.status})`;
        try {
          const data = await response.json();
          message = data.error ?? message;
        } catch {
          // Non-JSON error body; fall back to the status-code-based message.
        }
        setUploadError(message);
        setHasUploadedDoc(false);
        return;
      }
      setHasUploadedDoc(true);
    } catch {
      setUploadError('Upload failed. Check your connection and try again.');
      setHasUploadedDoc(false);
    } finally {
      setIsUploading(false);
    }
  }

  function onFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void uploadSermonDoc(file);
  }

  async function saveFeedback() {
    if (feedbackText.trim().length === 0) {
      const confirmed = window.confirm('Clear all feedback notes?');
      if (!confirmed) return;
    }
    setFeedbackSaveStatus('saving');
    try {
      const response = await fetch(`${API_URL}/feedback`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: feedbackText }),
      });
      if (!response.ok) {
        toast.error(`Save failed (status ${response.status}). Check your connection and try again.`);
        setFeedbackSaveStatus('idle');
        return;
      }
      setFeedbackSaveStatus('saved');
      toast.success('Feedback notes saved.');
    } catch {
      toast.error('Save failed. Check your connection and try again.');
      setFeedbackSaveStatus('idle');
    }
  }

  async function downloadFeedbackCsv(url: string) {
    try {
      const response = await fetch(url, { method: 'POST' });
      if (!response.ok) {
        toast.error(`Download failed (status ${response.status}). Check your connection and try again.`);
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : 'feedback.csv';
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
      await fetchViewerFeedback();
    } catch {
      toast.error('Download failed. Check your connection and try again.');
    }
  }

  function downloadFeedbackItem(id: string) {
    void downloadFeedbackCsv(`${API_URL}/viewer-feedback/${id}/download`);
  }

  function downloadAllUndownloadedFeedback() {
    void downloadFeedbackCsv(`${API_URL}/viewer-feedback/download-all`);
  }

  async function ensureRecorderStreaming(socket: WebSocket) {
    if (!streamRef.current) {
      try {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? `Microphone access failed: ${error.message}`
            : "Microphone access failed. Check your browser's microphone permission for this site."
        );
        manuallyStoppedRef.current = true;
        socket.send(JSON.stringify({ type: 'stop' }));
        socket.close();
        setStatus('error');
        return;
      }
    }
    const recorder = new MediaRecorder(streamRef.current, { mimeType: 'audio/webm;codecs=opus' });
    recorderRef.current = recorder;

    recorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
        socket.send(await event.data.arrayBuffer());
      }
    };

    recorder.start(250);
  }

  function connectSocket() {
    const socket = new WebSocket(`${WS_URL}/ws/capture`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'status') {
        setStatus(message.status);
      } else if (message.type === 'transcript') {
        setTranscriptLines((previous) => {
          const index = previous.findIndex((line) => line.id === message.id);
          const updated: TranscriptLine = {
            id: message.id,
            text: message.english,
            flagged: Boolean(message.flagged),
            reason: message.reason,
            pending: Boolean(message.pending),
          };
          if (index === -1) return [...previous.slice(-49), updated];
          const next = [...previous];
          next[index] = updated;
          return next;
        });
      } else if (message.type === 'reinstate-error') {
        setTranscriptLines((previous) =>
          previous.map((line) =>
            line.id === message.id ? { ...line, reinstateState: 'error', reinstateError: message.error } : line
          )
        );
      } else if (message.type === 'admin-remove-error') {
        setTranscriptLines((previous) =>
          previous.map((line) =>
            line.id === message.id ? { ...line, removeState: 'error', removeError: message.error } : line
          )
        );
      } else if (message.type === 'cost') {
        setSessionCostUsd(message.sessionUsd);
        setLifetimeCostUsd(message.lifetimeUsd);
      }
    };

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'start' }));
      socket.send(JSON.stringify({ type: 'set-mode', mode: modeRef.current }));
      void ensureRecorderStreaming(socket);
    };

    socket.onclose = () => {
      if (manuallyStoppedRef.current) {
        setStatus((current) => (current === 'error' ? current : 'idle'));
        return;
      }
      setStatus('reconnecting');
      reconnectTimeoutRef.current = setTimeout(connectSocket, 2000);
    };
  }

  function start() {
    manuallyStoppedRef.current = false;
    setErrorMessage(null);
    setSessionCostUsd(0);
    setTranscriptLines([]);
    setIsFollowing(true);
    connectSocket();
  }

  function stop() {
    manuallyStoppedRef.current = true;
    clearTimeout(reconnectTimeoutRef.current);
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    socketRef.current?.send(JSON.stringify({ type: 'stop' }));
    socketRef.current?.close();
    setHasUploadedDoc(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function beginEditing(id: string, currentText: string) {
    setTranscriptLines((previous) =>
      previous.map((line) =>
        line.id === id ? { ...line, reinstateState: 'editing', editedText: currentText, reinstateError: undefined } : line
      )
    );
  }

  function cancelEditing(id: string) {
    setTranscriptLines((previous) =>
      previous.map((line) => (line.id === id ? { ...line, reinstateState: undefined, editedText: undefined } : line))
    );
  }

  function updateEditedText(id: string, text: string) {
    setTranscriptLines((previous) => previous.map((line) => (line.id === id ? { ...line, editedText: text } : line)));
  }

  function sendReinstate(id: string) {
    if (status !== 'recording') return;
    const line = transcriptLines.find((entry) => entry.id === id);
    if (!line) return;
    const editedText = (line.editedText ?? line.text).trim();
    if (editedText.length === 0) return;
    if (!line.pending) {
      const confirmed = window.confirm(`Flagged: "${line.reason ?? 'no reason given'}". Send this line to viewers?`);
      if (!confirmed) return;
    }
    setTranscriptLines((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, reinstateState: 'pending' } : entry))
    );
    socketRef.current?.send(JSON.stringify({ type: 'reinstate', id, english: editedText }));
  }

  function sendAdminRemove(id: string) {
    if (status !== 'recording') return;
    const confirmed = window.confirm('Remove this line? It can be reinstated afterward.');
    if (!confirmed) return;
    setTranscriptLines((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, removeState: 'pending' } : entry))
    );
    socketRef.current?.send(JSON.stringify({ type: 'admin-remove', id }));
  }

  function rejectLine(id: string) {
    setTranscriptLines((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, dismissed: true } : entry))
    );
  }

  return (
    <main className="flex min-h-screen flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-3 border-b bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Sermon Capture</h1>
            <StatusBadge status={status} />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={start} disabled={status === 'recording' || status === 'reconnecting'}>
              Start
            </Button>
            <Button variant="secondary" onClick={stop} disabled={status === 'idle'}>
              Stop
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <span>
            Session: ${sessionCostUsd.toFixed(4)} · Lifetime: ${lifetimeCostUsd.toFixed(2)}
          </span>
          <div className="flex items-center gap-2">
            <label htmlFor="sermon-doc" className="font-medium text-foreground">
              Sermon document
            </label>
            <input
              id="sermon-doc"
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx"
              onChange={onFileSelected}
              disabled={status === 'recording' || status === 'reconnecting' || isUploading}
              className="text-xs"
            />
            {isUploading && <span>Uploading…</span>}
            {hasUploadedDoc && !isUploading && <span className="text-green-500">Loaded.</span>}
            {uploadError && <span className="text-destructive">{uploadError}</span>}
          </div>
        </div>
        {errorMessage && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}
      </div>

      <Tabs defaultValue="live" className="flex-1 p-4">
        <TabsList>
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="notes">Feedback notes</TabsTrigger>
          <TabsTrigger value="viewer-feedback">
            Viewer feedback
            {undownloadedFeedbackCount > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {undownloadedFeedbackCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              type="single"
              value={mode}
              onValueChange={(value) => {
                if (value) setMode(value as 'automatic' | 'manual');
              }}
            >
              <ToggleGroupItem value="automatic">Automatic</ToggleGroupItem>
              <ToggleGroupItem value="manual">Manual</ToggleGroupItem>
            </ToggleGroup>
            {mode === 'manual' && (
              <span className="text-sm text-muted-foreground">{pendingQueue.length} pending</span>
            )}
            {mode === 'manual' && (
              <Popover>
                <PopoverTrigger render={<Button variant="ghost" size="sm">Shortcuts</Button>} />
                <PopoverContent className="w-72">
                  <div className="flex flex-col gap-2 text-sm">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setRebindError(null);
                        setRebindingAction('approve');
                      }}
                    >
                      Approve: {rebindingAction === 'approve' ? 'press a key…' : displayKey(approveKey)}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setRebindError(null);
                        setRebindingAction('reject');
                      }}
                    >
                      Reject: {rebindingAction === 'reject' ? 'press a key…' : displayKey(rejectKey)}
                    </Button>
                    {rebindError && <p className="text-xs text-destructive">{rebindError}</p>}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>

          {mode === 'manual' && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Pending approval ({pendingQueue.length})</p>
              {pendingQueue.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing waiting.</p>
              ) : (
                <ScrollArea className="h-64 rounded-md border">
                  <div className="divide-y">
                    {pendingQueue.map((line, index) => (
                      <div key={line.id} className={`p-2 flex flex-col gap-1 ${index === 0 ? 'bg-accent/30' : ''}`}>
                        <p className="text-sm">{line.text}</p>
                        {line.reason && <p className="text-xs text-muted-foreground">{line.reason}</p>}
                        {line.reinstateState === 'editing' && status === 'recording' ? (
                          <div className="flex flex-col gap-1">
                            <Textarea
                              value={line.editedText ?? line.text}
                              onChange={(event) => updateEditedText(line.id, event.target.value)}
                              rows={2}
                              className="text-xs"
                            />
                            <div className="flex items-center gap-2">
                              <Button
                                size="xs"
                                onClick={() => sendReinstate(line.id)}
                                disabled={(line.editedText ?? line.text).trim().length === 0}
                              >
                                Send
                              </Button>
                              <Button size="xs" variant="ghost" onClick={() => cancelEditing(line.id)}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Button
                              size="xs"
                              onClick={() => sendReinstate(line.id)}
                              disabled={status !== 'recording' || line.reinstateState === 'pending'}
                            >
                              {index === 0 ? `Approve (${displayKey(approveKey)})` : 'Approve'}
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => beginEditing(line.id, line.text)}
                              disabled={status !== 'recording' || line.reinstateState === 'pending'}
                            >
                              Edit
                            </Button>
                            <Button size="xs" variant="destructive" onClick={() => rejectLine(line.id)}>
                              {index === 0 ? `Reject (${displayKey(rejectKey)})` : 'Reject'}
                            </Button>
                          </div>
                        )}
                        {line.reinstateState === 'error' && (
                          <p className="text-xs text-destructive">
                            Couldn&apos;t approve ({line.reinstateError}) — try again.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          )}

          <div className="relative">
            {!isFollowing && (
              <Button onClick={jumpToLatest} size="sm" className="absolute bottom-2 right-2 z-10 shadow">
                Jump to latest
              </Button>
            )}
            {/* Kept as a plain scrollable div (not ScrollArea): isFollowing/jumpToLatest need
               a direct ref to the element's scrollTop/scrollHeight/clientHeight. */}
            <div
              ref={transcriptRef}
              onScroll={onTranscriptScroll}
              className="h-64 w-full overflow-y-auto rounded-md border p-3 text-sm space-y-2"
            >
              {transcriptLines.map((line) => (
                <div key={line.id} className="group">
                  <div className="flex items-start justify-between gap-2">
                    <p className={line.flagged ? 'text-destructive line-through' : undefined}>{line.text}</p>
                    {!line.flagged && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => sendAdminRemove(line.id)}
                        disabled={status !== 'recording' || line.removeState === 'pending'}
                        className="text-destructive opacity-0 group-hover:opacity-100"
                      >
                        {line.removeState === 'pending' ? 'Removing…' : 'Remove'}
                      </Button>
                    )}
                  </div>
                  {line.flagged && line.reinstateState !== 'editing' && (
                    <div className="flex items-center gap-2 text-xs">
                      {line.reason && <span className="text-muted-foreground">Flagged: {line.reason}</span>}
                      <Button
                        variant="link"
                        size="xs"
                        onClick={() => beginEditing(line.id, line.text)}
                        disabled={status !== 'recording' || line.reinstateState === 'pending'}
                      >
                        {line.reinstateState === 'pending' ? 'Reinstating…' : 'Reinstate'}
                      </Button>
                    </div>
                  )}
                  {line.flagged && line.reinstateState === 'editing' && status === 'recording' && (
                    <div className="mt-1 flex flex-col gap-1">
                      <Textarea
                        value={line.editedText ?? line.text}
                        onChange={(event) => updateEditedText(line.id, event.target.value)}
                        rows={2}
                        className="text-xs"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="xs"
                          onClick={() => sendReinstate(line.id)}
                          disabled={(line.editedText ?? line.text).trim().length === 0}
                        >
                          Send
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => cancelEditing(line.id)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  {line.reinstateState === 'error' && (
                    <p className="text-xs text-destructive">
                      Couldn&apos;t reinstate ({line.reinstateError}) — try again.
                    </p>
                  )}
                  {line.removeState === 'error' && (
                    <p className="text-xs text-destructive">Couldn&apos;t remove ({line.removeError}) — try again.</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="notes" className="flex max-w-2xl flex-col gap-2">
          <label className="text-sm font-medium">Feedback notes (optional)</label>
          <Textarea
            value={feedbackText}
            onChange={(event) => {
              setFeedbackText(event.target.value);
              setFeedbackSaveStatus('idle');
            }}
            rows={10}
            placeholder="Notes about past translation accuracy issues, e.g. names that were missed…"
          />
          <div>
            <Button variant="secondary" onClick={saveFeedback} disabled={feedbackSaveStatus === 'saving'}>
              Save feedback notes
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="viewer-feedback" className="flex max-w-2xl flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium">Viewer feedback</label>
            <Button
              variant="secondary"
              size="sm"
              onClick={downloadAllUndownloadedFeedback}
              disabled={undownloadedFeedbackCount === 0}
            >
              Download all undownloaded ({undownloadedFeedbackCount} new)
            </Button>
          </div>
          {viewerFeedback.length === 0 ? (
            <p className="text-sm text-muted-foreground">No feedback yet.</p>
          ) : (
            <ScrollArea className="h-80 rounded-md border">
              <div className="divide-y">
                {viewerFeedback.map((item) => (
                  <div key={item.id} className="p-2 flex flex-col gap-1 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {new Date(item.timestamp).toLocaleString()} · {item.language}
                        {item.downloaded ? ' · downloaded' : ' · new'}
                      </span>
                      <Button variant="link" size="xs" onClick={() => downloadFeedbackItem(item.id)}>
                        Download
                      </Button>
                    </div>
                    <p className="text-muted-foreground">{item.english}</p>
                    <p>{item.translated}</p>
                    {item.comment && <p className="italic">&quot;{item.comment}&quot;</p>}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </TabsContent>
      </Tabs>
    </main>
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
cd web && npm run build
```

Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Manual check**

Run `npm run dev` plus `server` per `README.md`. Open `http://localhost:3000/capture`. Confirm: sticky header stays visible while scrolling the tab content; status badge shows Idle/Recording/Reconnecting/Error correctly across Start/Stop; the Live/Feedback notes/Viewer feedback tabs switch correctly; in Manual mode the mode toggle, pending queue, Approve/Reject buttons and their keyboard shortcuts (default `Enter`/`Space`), and the Shortcuts popover rebinding flow all work exactly as before; saving feedback notes shows a toast instead of inline text; sermon doc upload, transcript remove/reinstate, and viewer-feedback download/download-all all behave identically to before.

- [ ] **Step 4: Commit**

```bash
git add web/app/capture/page.tsx
git commit -m "Redesign capture page as a tabbed dashboard with sticky status header"
```

---

### Task 5: Admin page redesign

**Files:**
- Modify: `web/app/admin/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `Card`/`CardHeader`/`CardTitle`/`CardAction`/`CardContent` (existing `Card`, new sub-parts from Task 1's shadcn install — `Card` already exports these per `web/components/ui/card.tsx`), `Button`, `Input`, `Alert`/`AlertDescription`, `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, `Select`/`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectGroup`/`SelectItem`, `ToggleGroup`/`ToggleGroupItem`, `RadioGroup`/`RadioGroupItem`, `Textarea`, `toast` from `"sonner"` (from Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace `web/app/admin/page.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type GeminiModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';
type Provider = 'gemini' | 'openrouter';
type OpenRouterReasoningEffort = 'off' | 'low' | 'medium' | 'high';
type RoleModelSelection =
  | { provider: 'gemini'; model: GeminiModelId }
  | { provider: 'openrouter'; model: string; reasoning?: OpenRouterReasoningEffort };
type Role = 'transcriptionVerifier' | 'translation' | 'translationVerifier';

interface ModelConfig {
  transcriptionVerifier: RoleModelSelection;
  translation: RoleModelSelection;
  translationVerifier: RoleModelSelection;
}

interface PromptConfig {
  transcriptionVerifier: string;
  translation: string;
  translationVerifier: string;
}

type TranslationFlagDisplayMode = 'hide' | 'flag';

interface TranslationFlagDisplayConfig {
  mode: TranslationFlagDisplayMode;
}

const ROLE_LABELS: Record<Role, string> = {
  transcriptionVerifier: 'Transcription verifier',
  translation: 'Translation',
  translationVerifier: 'Translation verifier',
};

const ROLES: Role[] = ['transcriptionVerifier', 'translation', 'translationVerifier'];
const GEMINI_MODEL_IDS: GeminiModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];
const REASONING_EFFORTS: OpenRouterReasoningEffort[] = ['off', 'low', 'medium', 'high'];
const REASONING_LABELS: Record<OpenRouterReasoningEffort, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export default function AdminPage() {
  const [passcode, setPasscode] = useState('');
  const [enteredPasscode, setEnteredPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(false);

  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
  const [modelSaveStatus, setModelSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const [notes, setNotes] = useState<PromptConfig | null>(null);
  const [fixedRules, setFixedRules] = useState<PromptConfig | null>(null);
  const [notesSaveStatus, setNotesSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const [displayConfig, setDisplayConfig] = useState<TranslationFlagDisplayConfig | null>(null);
  const [displaySaveStatus, setDisplaySaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const [openRouterModels, setOpenRouterModels] = useState<string[]>([]);
  const [newModelInputs, setNewModelInputs] = useState<Record<Role, string>>({
    transcriptionVerifier: '',
    translation: '',
    translationVerifier: '',
  });

  useEffect(() => {
    const stored = window.sessionStorage.getItem('adminPasscode');
    if (stored) {
      setPasscode(stored);
      void loadAll(stored);
    }
  }, []);

  async function loadAll(candidatePasscode: string) {
    setCheckingAuth(true);
    setAuthError(null);
    try {
      const [modelResponse, promptResponse, displayResponse, openRouterModelsResponse] = await Promise.all([
        fetch(`${API_URL}/admin/model-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/prompt-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/translation-flag-display`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/openrouter-models`, { headers: { 'x-admin-passcode': candidatePasscode } }),
      ]);

      if (
        modelResponse.status === 401 ||
        promptResponse.status === 401 ||
        displayResponse.status === 401 ||
        openRouterModelsResponse.status === 401
      ) {
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
      const openRouterModelsData = await openRouterModelsResponse.json();
      setOpenRouterModels(openRouterModelsData.models);

      window.sessionStorage.setItem('adminPasscode', candidatePasscode);
      setPasscode(candidatePasscode);
      setAuthorized(true);
    } catch {
      setAuthError('Could not reach the server. Check your connection and try again.');
    } finally {
      setCheckingAuth(false);
    }
  }

  function submitPasscode() {
    void loadAll(enteredPasscode);
  }

  async function saveModelConfig() {
    if (!modelConfig) return;
    setModelSaveStatus('saving');
    try {
      const response = await fetch(`${API_URL}/admin/model-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(modelConfig),
      });
      if (!response.ok) {
        toast.error(`Save failed (status ${response.status}).`);
        setModelSaveStatus('idle');
        return;
      }
      setModelSaveStatus('saved');
      toast.success('Models saved.');
    } catch {
      toast.error('Save failed. Check your connection and try again.');
      setModelSaveStatus('idle');
    }
  }

  async function addOpenRouterModel(role: Role) {
    const model = newModelInputs[role].trim();
    if (model.length === 0 || !modelConfig) return;
    try {
      const response = await fetch(`${API_URL}/admin/openrouter-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify({ model }),
      });
      if (!response.ok) return;
      const data = await response.json();
      setOpenRouterModels(data.models);
      setModelConfig({ ...modelConfig, [role]: { ...modelConfig[role], model } });
      setNewModelInputs({ ...newModelInputs, [role]: '' });
      setModelSaveStatus('idle');
    } catch {
      // Adding a model id is a convenience action; a network failure here just
      // leaves the input as-is for the admin to retry, same posture as the
      // existing save actions on this page.
    }
  }

  async function saveNotes() {
    if (!notes) return;
    setNotesSaveStatus('saving');
    try {
      const response = await fetch(`${API_URL}/admin/prompt-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(notes),
      });
      if (!response.ok) {
        toast.error(`Save failed (status ${response.status}).`);
        setNotesSaveStatus('idle');
        return;
      }
      setNotesSaveStatus('saved');
      toast.success('Prompt notes saved.');
    } catch {
      toast.error('Save failed. Check your connection and try again.');
      setNotesSaveStatus('idle');
    }
  }

  async function saveDisplayConfig() {
    if (!displayConfig) return;
    setDisplaySaveStatus('saving');
    try {
      const response = await fetch(`${API_URL}/admin/translation-flag-display`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(displayConfig),
      });
      if (!response.ok) {
        toast.error(`Save failed (status ${response.status}).`);
        setDisplaySaveStatus('idle');
        return;
      }
      setDisplaySaveStatus('saved');
      toast.success('Display setting saved.');
    } catch {
      toast.error('Save failed. Check your connection and try again.');
      setDisplaySaveStatus('idle');
    }
  }

  if (!authorized) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Admin access</CardTitle>
            <CardDescription>Enter the admin passcode to continue.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="relative">
              <Lock className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="password"
                value={enteredPasscode}
                onChange={(event) => setEnteredPasscode(event.target.value)}
                placeholder="Passcode"
                className="pl-8"
                disabled={checkingAuth}
              />
            </div>
            <Button onClick={submitPasscode} disabled={checkingAuth || enteredPasscode.length === 0}>
              {checkingAuth ? 'Checking…' : 'Enter'}
            </Button>
            {authError && (
              <Alert variant="destructive">
                <AlertDescription>{authError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 p-6">
      <h1 className="text-xl font-semibold">Admin</h1>
      <Tabs defaultValue="models" className="w-full max-w-2xl">
        <TabsList>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="notes">Prompt notes</TabsTrigger>
          <TabsTrigger value="display">Display</TabsTrigger>
        </TabsList>

        <TabsContent value="models" className="flex flex-col gap-4">
          {modelConfig &&
            ROLES.map((role) => {
              const selection = modelConfig[role];
              return (
                <Card key={role}>
                  <CardHeader>
                    <CardTitle>{ROLE_LABELS[role]}</CardTitle>
                    <CardAction>
                      <Select
                        value={selection.provider}
                        onValueChange={(value) => {
                          const provider = value as Provider;
                          const nextSelection: RoleModelSelection =
                            provider === 'gemini'
                              ? { provider: 'gemini', model: GEMINI_MODEL_IDS[0] }
                              : { provider: 'openrouter', model: openRouterModels[0] ?? '' };
                          setModelConfig({ ...modelConfig, [role]: nextSelection });
                          setModelSaveStatus('idle');
                        }}
                      >
                        <SelectTrigger className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="gemini">Gemini</SelectItem>
                            <SelectItem value="openrouter">OpenRouter</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {selection.provider === 'gemini' ? (
                      <Select
                        value={selection.model}
                        onValueChange={(value) => {
                          setModelConfig({
                            ...modelConfig,
                            [role]: { provider: 'gemini', model: value as GeminiModelId },
                          });
                          setModelSaveStatus('idle');
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {GEMINI_MODEL_IDS.map((id) => (
                              <SelectItem key={id} value={id}>
                                {id}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    ) : (
                      <>
                        <Select
                          value={selection.model}
                          onValueChange={(value) => {
                            setModelConfig({ ...modelConfig, [role]: { ...selection, model: value } });
                            setModelSaveStatus('idle');
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="No models added yet" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {openRouterModels.map((id) => (
                                <SelectItem key={id} value={id}>
                                  {id}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Thinking</span>
                          <ToggleGroup
                            type="single"
                            value={selection.reasoning ?? 'off'}
                            onValueChange={(value) => {
                              if (!value) return;
                              const reasoning = value as OpenRouterReasoningEffort;
                              setModelConfig({
                                ...modelConfig,
                                [role]: { ...selection, reasoning: reasoning === 'off' ? undefined : reasoning },
                              });
                              setModelSaveStatus('idle');
                            }}
                          >
                            {REASONING_EFFORTS.map((effort) => (
                              <ToggleGroupItem key={effort} value={effort} size="sm">
                                {REASONING_LABELS[effort]}
                              </ToggleGroupItem>
                            ))}
                          </ToggleGroup>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            value={newModelInputs[role]}
                            onChange={(event) => setNewModelInputs({ ...newModelInputs, [role]: event.target.value })}
                            placeholder="e.g. qwen/qwen3.6-flash"
                            className="flex-1"
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void addOpenRouterModel(role)}
                            disabled={newModelInputs[role].trim().length === 0}
                          >
                            Add
                          </Button>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          <div>
            <Button variant="secondary" onClick={saveModelConfig} disabled={modelSaveStatus === 'saving'}>
              Save models
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="notes" className="flex flex-col gap-6">
          {notes &&
            fixedRules &&
            ROLES.map((role) => (
              <div key={role} className="flex flex-col gap-2">
                <label className="text-sm font-medium">{ROLE_LABELS[role]}</label>
                <Alert>
                  <AlertDescription className="whitespace-pre-wrap">{fixedRules[role]}</AlertDescription>
                </Alert>
                <Textarea
                  value={notes[role]}
                  onChange={(event) => {
                    setNotes({ ...notes, [role]: event.target.value });
                    setNotesSaveStatus('idle');
                  }}
                  rows={4}
                />
              </div>
            ))}
          <div>
            <Button variant="secondary" onClick={saveNotes} disabled={notesSaveStatus === 'saving'}>
              Save notes
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="display" className="flex max-w-xl flex-col gap-4">
          {displayConfig && (
            <RadioGroup
              value={displayConfig.mode}
              onValueChange={(value) => {
                setDisplayConfig({ mode: value as TranslationFlagDisplayMode });
                setDisplaySaveStatus('idle');
              }}
              className="flex flex-col gap-3"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="hide" id="display-hide" />
                <label htmlFor="display-hide" className="text-sm">
                  Hide (fallback to English)
                </label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="flag" id="display-flag" />
                <label htmlFor="display-flag" className="text-sm">
                  Show in viewer, marked red, with reason
                </label>
              </div>
            </RadioGroup>
          )}
          <div>
            <Button variant="secondary" onClick={saveDisplayConfig} disabled={displaySaveStatus === 'saving'}>
              Save display setting
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
cd web && npm run build
```

Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Manual check**

Run `npm run dev` plus `server`. Open `http://localhost:3000/admin`, enter the passcode configured in `server/.env`. Confirm: the three tabs (Models/Prompt notes/Display) switch correctly; each role's provider/model `Select`s work and preserve existing state shape; the reasoning-effort `ToggleGroup` only appears for OpenRouter and its 4 options match `off/low/medium/high`; adding a new OpenRouter model id via the input+Add button still updates the list and selects it; each of the three Save buttons shows a toast on success/failure instead of inline text; the Display tab's `RadioGroup` saves correctly.

- [ ] **Step 4: Commit**

```bash
git add web/app/admin/page.tsx
git commit -m "Redesign admin page as tabbed Models/Prompt notes/Display dashboard"
```

---

### Task 6: Style guide for future sessions

**Files:**
- Create: `web/docs/STYLE_GUIDE.md`
- Modify: `web/AGENTS.md` (one-line pointer)

**Interfaces:**
- Consumes: the actual system as built in Tasks 1–5 (accent tokens, component choices, layout patterns).
- Produces: a reference document future sessions load via `web/AGENTS.md` → `web/CLAUDE.md` (`web/CLAUDE.md` already does `@AGENTS.md`).

- [ ] **Step 1: Create `web/docs/STYLE_GUIDE.md`**

```markdown
# Web UI Style Guide

Written after the 2026-07-18 redesign (see `docs/superpowers/specs/2026-07-18-web-ux-redesign-design.md` and `docs/superpowers/plans/2026-07-18-web-ux-redesign.md` for full rationale and history). Read this before making UI changes in `web/app/` or `web/components/`.

## Accent color

One restrained accent — blue — lives entirely in three tokens in `web/app/globals.css`: `--primary`, `--ring`, and `--chart-1` (light block under `:root`, dark block under `.dark`). Everything else stays on the `neutral` shadcn base color. Don't add a second accent color or override `bg-primary`/`ring`/`text-primary` with a raw color anywhere else — if the accent needs to change (e.g. a real church brand color arrives), change it in exactly those two places in `globals.css` and every button/badge/focus-ring in the app updates automatically.

The app currently forces dark mode: `web/app/layout.tsx` hardcodes `className="dark ..."` on `<html>` and there is no theme toggle. Both light and dark token blocks exist in `globals.css` (shadcn always ships both), but only the dark block is ever actually rendered today — verify visual changes in dark mode.

## Split-persona layout principle

This app has two very different kinds of pages, and they're styled differently on purpose:

- **Audience-facing** (`app/page.tsx` landing, `app/view/page.tsx` viewer) — read by a congregant on their own phone, often at a glance. Large type, minimal chrome, generous spacing. Prefer plain, big, obviously-tappable controls over dense controls.
- **Operator-facing** (`app/capture/page.tsx`, `app/admin/page.tsx`) — used by one person on a laptop who needs everything organized, not glanceable. These use `Tabs` to split a page into sections (Live/Feedback notes/Viewer feedback on capture; Models/Prompt notes/Display on admin) instead of one long scrolling column, and a sticky header on the capture page keeps Start/Stop/status visible regardless of which tab or scroll position you're at.

When adding a new page or a large new section, decide which persona it serves before picking a layout — don't default to "one long column" for operator tools, and don't default to dense tabs/dashboards for anything a congregant reads on their phone.

## Component patterns established here

- **Status/"live" indicator**: a `Badge` with a `<span className="size-2 animate-pulse rounded-full bg-primary-foreground" />` dot, using the default (solid primary) `Badge` variant. Used identically on the viewer page and the capture page. Don't invent a second visual style for "is this live right now" — reuse this pattern.
- **Non-disruptive inline actions** (e.g. flagging a caption line on the viewer page): use `Popover` anchored to an icon `Button`, not an element that expands inline and reflows surrounding content. Reach for this whenever a small, secondary action would otherwise shift nearby content that someone might be mid-way through reading.
- **Save confirmations**: `toast()` from `sonner` (host mounted once in `web/app/layout.tsx` as `<Toaster theme="dark" />`), not inline "Saved."/error text that permanently occupies layout space. Exception: errors tied to a specific, still-visible field (e.g. the capture page's sermon-doc upload error, or a per-line reinstate/remove error in the transcript) stay as inline text next to that field — they're contextual, not a transient one-off confirmation, so a toast that disappears would be the wrong fit.
- **Multi-choice pickers**: `Select` for open-ended/long option lists (e.g. OpenRouter model ids), `ToggleGroup` for a small fixed set of mutually exclusive options (e.g. reasoning effort: off/low/medium/high; capture mode: automatic/manual), `RadioGroup` for a small fixed set presented as a form choice (e.g. admin's hide/flag display setting). Don't reach for a native `<select>` or raw `<input type="radio">` — every one of these has a shadcn component now.
- **Scroll containers**: use `ScrollArea` for any scrollable list that never needs programmatic scroll-position reads (e.g. the capture page's pending-approval queue and viewer-feedback list). Keep a plain `overflow-y-auto` div with a `ref` when the container needs `scrollTop`/`scrollHeight` reads for auto-follow/jump-to-latest behavior (the viewer page's caption container, the capture page's transcript panel) — shadcn's `ScrollArea` doesn't expose its internal scrollable viewport as a plain ref target, so don't force it there.
- **Base library, not Radix**: this project's shadcn style (`base-nova`) is backed by `@base-ui/react`, not Radix — confirmed by `web/components/ui/button.tsx`. Custom triggers use the `render` prop (e.g. `<PopoverTrigger render={<Button>...</Button>} />`), not `asChild`.

## Adding new shadcn components

Check `web/components/ui/` before running `npx shadcn@latest add <name>` — don't re-add an already-installed component. Run `npx shadcn@latest docs <name>` and read the fetched docs before using an unfamiliar component's props; don't guess at prop names from memory or from a similar-looking library.
```

- [ ] **Step 2: Add a pointer from `web/AGENTS.md`**

Read the current content of `web/AGENTS.md` first (it's short — a warning about this being a non-standard Next.js version), then append:

```markdown

# UI style guide

Before making changes under `app/` or `components/`, read `docs/STYLE_GUIDE.md` — it documents the accent color, the split-persona layout principle, and the component patterns already established in this codebase.
```

- [ ] **Step 3: Verify the doc reads correctly end-to-end**

Open `web/docs/STYLE_GUIDE.md` and confirm every file path it references (`web/app/globals.css`, `web/app/layout.tsx`, `web/app/page.tsx`, `web/app/view/page.tsx`, `web/app/capture/page.tsx`, `web/app/admin/page.tsx`, `web/components/ui/button.tsx`) actually exists and matches what Tasks 1–5 produced.

- [ ] **Step 4: Commit**

```bash
git add web/docs/STYLE_GUIDE.md web/AGENTS.md
git commit -m "Add web UI style guide for future sessions"
```

---

## Self-Review Notes

- **Spec coverage:** Foundation (accent tokens, component install, toast host) → Task 1. Landing → Task 2. Viewer (status badge, icon actions, flag popover, caption sizing) → Task 3. Capture (sticky header, tabs, mode toggle, shortcuts popover, ScrollArea/Card) → Task 4. Admin (passcode Card, tabs, Select/ToggleGroup/RadioGroup) → Task 5. Style guide deliverable → Task 6. All spec sections have a task.
- **Deliberate deviations from a literal reading of the spec, called out explicitly rather than left ambiguous:** (1) the capture page's main transcript panel and the viewer page's caption container keep a raw `overflow-y-auto` div instead of `ScrollArea`, because both need a direct `ref` to read `scrollTop`/`scrollHeight` for existing auto-follow/jump-to-latest behavior that must not change — `ScrollArea` is used everywhere else that doesn't need this. (2) Field-scoped errors (sermon-doc upload, per-line reinstate/remove) stay inline rather than becoming toasts, since they're tied to a specific still-visible control rather than being one-off action confirmations.
- **Type consistency:** `RoleModelSelection`, `Role`, `ModelConfig`, `PromptConfig`, `TranslationFlagDisplayConfig`, `TranscriptLine`, `ViewerFeedbackItem`, `CaptionLine`/`ViewerStatus` (from `@/lib/useViewerSocket`) are used with identical shapes/names across every task that touches them — none were renamed from the original files.
- **No placeholders:** every step above has complete, runnable code or an exact command; no "TODO"/"add appropriate handling" remain.
