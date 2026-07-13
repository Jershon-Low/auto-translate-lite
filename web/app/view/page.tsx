'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useViewerSocket } from '@/lib/useViewerSocket';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';

function ViewerPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const language = searchParams.get('lang') ?? '';
  const { status, lines } = useViewerSocket(language, `${WS_URL}/ws/viewer`);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

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

  if (!language) return null;

  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="p-3 text-sm text-muted-foreground flex justify-between items-center border-b">
        <span>
          {status === 'connecting' && 'Connecting…'}
          {status === 'reconnecting' && 'Reconnecting…'}
          {status === 'live' && lines.length === 0 && 'Waiting for the service to start…'}
          {status === 'live' && lines.length > 0 && 'Live'}
        </span>
        <a href="/?reset=1" className="underline">
          Change language
        </a>
      </div>
      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4">
        {lines.map((line, index) => (
          <div key={index}>
            <p className="text-sm text-muted-foreground">{line.english}</p>
            <p className="text-xl">{line.translated}</p>
          </div>
        ))}
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
