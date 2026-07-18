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
import { useStoredValue } from '@/lib/useStoredValue';

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

  const storedApproveKey = useStoredValue('captureApproveKey');
  const storedRejectKey = useStoredValue('captureRejectKey');
  const [approveKeyOverride, setApproveKeyOverride] = useState<string | null>(null);
  const [rejectKeyOverride, setRejectKeyOverride] = useState<string | null>(null);
  const approveKey = approveKeyOverride ?? storedApproveKey ?? 'Enter';
  const rejectKey = rejectKeyOverride ?? storedRejectKey ?? ' ';
  const [rebindingAction, setRebindingAction] = useState<'approve' | 'reject' | null>(null);
  const [rebindError, setRebindError] = useState<string | null>(null);

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
        setApproveKeyOverride(key);
        window.localStorage.setItem('captureApproveKey', key);
      } else {
        setRejectKeyOverride(key);
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
            <label htmlFor="sermon-doc" className="flex items-center font-medium text-foreground bg-muted px-3 h-8 rounded-md text-sm text-center">
              Sermon document (optional, PDF or Word)
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
            {hasUploadedDoc && !isUploading && <span className="text-green-500">Document loaded.</span>}
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
              value={[mode]}
              onValueChange={(values) => {
                const newMode = values[0];
                if (newMode) setMode(newMode as 'automatic' | 'manual');
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
                  <div className="flex items-start justify-between gap-2 hover:bg-accent/30 rounded-md">
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
