'use client';

import { useEffect, useRef, useState } from 'react';

export interface CaptionLine {
  id: string;
  english: string;
  translated: string;
  removed?: boolean;
  flagged?: boolean;
  reason?: string;
  pending?: boolean;
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
        } else if (message.type === 'caption-pending') {
          setLines((previous) => {
            if (previous.some((line) => line.id === message.id)) return previous;
            return [...previous, { id: message.id, english: message.english, translated: '', pending: true }];
          });
          setStatus('live');
        } else if (message.type === 'caption' || message.type === 'caption-inserted') {
          setLines((previous) => {
            const index = previous.findIndex((line) => line.id === message.id);
            const resolved = {
              id: message.id,
              english: message.english,
              translated: message.translated,
              ...(message.flagged ? { flagged: true, reason: message.reason } : {}),
            };
            if (index === -1) return [...previous, resolved];
            const next = [...previous];
            next[index] = resolved;
            return next;
          });
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
