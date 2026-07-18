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
          <Button variant="ghost" size="sm" nativeButton={false} render={<a href="/?reset=1" />}>
            <Globe data-icon="inline-start" />
            Change language
          </Button>
        </div>
      </div>
      {exportError && <p className="px-3 pt-2 text-sm text-destructive">{exportError}</p>}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 sm:px-10 pt-4 pb-16 space-y-3"
      >
        {lines.map((line, index) =>
          line.removed ? (
            <div key={line.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex-1 border-t border-dashed" />
              <span>Line removed</span>
              <span className="flex-1 border-t border-dashed" />
            </div>
          ) : (
            <div key={line.id} className="flex items-start gap-2 hover:bg-accent/50 p-2 rounded-md transition-colors">
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
