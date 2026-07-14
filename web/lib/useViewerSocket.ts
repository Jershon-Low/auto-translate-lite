'use client';

import { useEffect, useRef, useState } from 'react';

export interface CaptionLine {
  english: string;
  translated: string;
  removed?: boolean;
}

export type ViewerStatus = 'connecting' | 'reconnecting' | 'live';

export function useViewerSocket(language: string, wsUrl: string) {
  const [status, setStatus] = useState<ViewerStatus>('connecting');
  const [lines, setLines] = useState<CaptionLine[]>([]);

  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let socket: WebSocket;

    function connect() {
      socket = new WebSocket(wsUrl);
      setStatus('connecting');

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'subscribe', language }));
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'backlog') {
          setLines(message.lines);
          setStatus('live');
        } else if (message.type === 'caption') {
          setLines((previous) => [
            ...previous,
            { english: message.english, translated: message.translated },
          ]);
          setStatus('live');
        } else if (message.type === 'line-removed') {
          setLines((previous) => [...previous, { english: '', translated: '', removed: true }]);
          setStatus('live');
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setStatus('reconnecting');
        reconnectTimeout = setTimeout(connect, 2000);
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimeout);
      socket?.close();
    };
  }, [language, wsUrl]);

  return { status, lines };
}
