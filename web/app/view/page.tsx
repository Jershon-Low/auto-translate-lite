'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useViewerSocket } from '@/lib/useViewerSocket';
import { exportTranscriptPdf } from '@/lib/exportTranscriptPdf';
import { TARGET_LANGUAGES } from '@/lib/languages';
import { getFeedbackStrings } from '@/lib/feedbackStrings';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

function ViewerPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const language = searchParams.get('lang') ?? '';
  const { status, lines } = useViewerSocket(language, `${WS_URL}/ws/viewer`);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

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

    if (state.mode === 'idle') {
      return (
        <button
          onClick={() => openFeedback(index)}
          aria-label="Flag this line"
          className="text-lg leading-none text-muted-foreground hover:text-foreground"
        >
          ⚑
        </button>
      );
    }

    if (state.mode === 'flagged') {
      return (
        <button
          onClick={() => openFeedback(index)}
          aria-label="Flag this line again"
          className="text-lg leading-none opacity-40"
        >
          ⚑
        </button>
      );
    }

    if (state.mode === 'submitted') {
      return <span className="text-xs text-green-600 whitespace-nowrap">{strings.thanksConfirmation}</span>;
    }

    return (
      <div className="flex flex-col gap-1 w-48 shrink-0">
        <textarea
          value={state.comment}
          onChange={(event) => updateFeedbackComment(index, event.target.value)}
          rows={2}
          className="w-full border rounded p-1 text-xs"
          placeholder={strings.flagPlaceholder}
          disabled={state.mode === 'submitting'}
        />
        <div className="flex gap-2">
          <button
            onClick={() => void submitFeedback(index, line, state.comment)}
            disabled={state.mode === 'submitting'}
            className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded disabled:opacity-50"
          >
            {strings.submit}
          </button>
          <button
            onClick={() => cancelFeedback(index)}
            disabled={state.mode === 'submitting'}
            className="text-xs underline disabled:opacity-50"
          >
            {strings.cancel}
          </button>
        </div>
        {state.mode === 'error' && <p className="text-xs text-destructive">{strings.submitError}</p>}
      </div>
    );
  }

  if (!language) return null;

  return (
    <main className="h-dvh bg-background text-foreground flex flex-col">
      <div className="p-3 text-sm text-muted-foreground flex justify-between items-center border-b">
        <span>
          {status === 'connecting' && 'Connecting…'}
          {status === 'reconnecting' && 'Reconnecting…'}
          {status === 'live' && lines.length === 0 && 'Waiting for the service to start…'}
          {status === 'live' && lines.length > 0 && 'Live'}
        </span>
        <div className="flex items-center gap-4">
          <button
            onClick={handleExportPdf}
            disabled={lines.length === 0 || isExporting}
            className="underline disabled:opacity-50 disabled:no-underline"
          >
            {isExporting ? 'Generating…' : 'Download Transcript (PDF)'}
          </button>
          <a href="/?reset=1" className="underline">
            Change language
          </a>
        </div>
      </div>
      {exportError && <p className="px-3 pt-2 text-sm text-destructive">{exportError}</p>}
      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4">
        {lines.map((line, index) =>
          line.removed ? (
            <div key={index} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex-1 border-t border-dashed" />
              <span>Line removed</span>
              <span className="flex-1 border-t border-dashed" />
            </div>
          ) : (
            <div key={index} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground">{line.english}</p>
                <p className="text-xl">{line.translated}</p>
              </div>
              {renderLineFeedback(index, line)}
            </div>
          )
        )}
        <div ref={bottomRef} />
      </div>
      {showJumpButton && (
        <button
          onClick={jumpToLatest}
          className="fixed bottom-6 right-6 bg-primary text-primary-foreground rounded-full px-4 py-2 shadow-lg"
        >
          Jump to latest ↓
        </button>
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
