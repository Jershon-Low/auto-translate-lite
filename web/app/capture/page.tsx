'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Lock } from 'lucide-react';
import { useStoredValue } from '@/lib/useStoredValue';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type CaptureStatus = 'idle' | 'recording' | 'reconnecting' | 'error';

type TranscriptLine = {
  id: string;
  text: string;
  flagged: boolean;
};

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
  const storedPasscode = useStoredValue('adminPasscode', 'session');
  const [enteredPasscode, setEnteredPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authorizedPasscodeOverride, setAuthorizedPasscodeOverride] = useState<string | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(false);

  const passcode = authorizedPasscodeOverride ?? storedPasscode ?? '';
  const authorized = authorizedPasscodeOverride !== null || Boolean(storedPasscode);

  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const manuallyStoppedRef = useRef(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);

  async function submitPasscode() {
    setCheckingAuth(true);
    setAuthError(null);
    try {
      const response = await fetch(`${API_URL}/feedback`, {
        headers: { 'x-admin-passcode': enteredPasscode },
      });
      if (response.status === 401) {
        setAuthError('Incorrect passcode.');
        return;
      }
      window.sessionStorage.setItem('adminPasscode', enteredPasscode);
      setAuthorizedPasscodeOverride(enteredPasscode);
    } catch {
      setAuthError('Could not reach the server. Check your connection and try again.');
    } finally {
      setCheckingAuth(false);
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

  function attachRecorder(socket: WebSocket) {
    if (!streamRef.current) {
      setErrorMessage("Microphone access failed. Check your browser's microphone permission for this site.");
      manuallyStoppedRef.current = true;
      socket.send(JSON.stringify({ type: 'stop' }));
      socket.close();
      setStatus('error');
      return;
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
    const socket = new WebSocket(`${WS_URL}/ws/capture?passcode=${encodeURIComponent(passcode)}`);
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
          };
          if (index === -1) return [...previous.slice(-49), updated];
          const next = [...previous];
          next[index] = updated;
          return next;
        });
      }
    };

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'start' }));
      attachRecorder(socket);
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

  async function start() {
    manuallyStoppedRef.current = false;
    setErrorMessage(null);
    setTranscriptLines([]);
    setIsFollowing(true);

    // Acquired synchronously in response to the click (not inside an async
    // socket callback) — some browsers only reliably deliver live audio
    // frames when getUserMedia is called directly within the user-gesture
    // chain, even if the permission was already granted. Re-requesting fresh
    // on every start (rather than reusing a stream left over from a previous
    // recording) also avoids a stale/half-released device from a prior stop().
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? `Microphone access failed: ${error.message}`
          : "Microphone access failed. Check your browser's microphone permission for this site."
      );
      setStatus('error');
      return;
    }

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
  }

  if (!authorized) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Capture access</CardTitle>
            <CardDescription>Enter the passcode to continue.</CardDescription>
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
        {errorMessage && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="relative flex-1 p-4">
        {!isFollowing && (
          <Button onClick={jumpToLatest} size="sm" className="absolute right-6 top-6 z-10 shadow">
            Jump to latest
          </Button>
        )}
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className="h-full w-full overflow-y-auto rounded-md border p-3 text-sm space-y-2"
        >
          {transcriptLines.map((line) => (
            <p key={line.id} className={line.flagged ? 'text-destructive line-through' : undefined}>
              {line.text}
            </p>
          ))}
        </div>
      </div>
    </main>
  );
}
