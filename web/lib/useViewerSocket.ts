'use client';

import { useEffect, useRef, useState } from 'react';

export interface CaptionLine {
  id: string;
  english: string;
  translated: string;
  removed?: boolean;
  flagged?: boolean;
  reason?: string;
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
            {
              id: message.id,
              english: message.english,
              translated: message.translated,
              ...(message.flagged ? { flagged: true, reason: message.reason } : {}),
            },
          ]);
          setStatus('live');
        } else if (message.type === 'line-removed') {
          setLines((previous) => {
            const index = previous.findIndex((line) => line.id === message.id);
            const placeholder = { id: message.id, english: '', translated: '', removed: true };
            if (index === -1) return [...previous, placeholder];
            const next = [...previous];
            next[index] = placeholder;
            return next;
          });
          setStatus('live');
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
