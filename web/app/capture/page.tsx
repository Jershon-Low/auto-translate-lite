'use client';

import { useEffect, useRef, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type CaptureStatus = 'idle' | 'recording' | 'reconnecting' | 'error';

type TranscriptLine = {
  id: string;
  text: string;
  flagged: boolean;
  reason?: string;
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
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [viewerFeedback, setViewerFeedback] = useState<ViewerFeedbackItem[]>([]);
  const [feedbackDownloadError, setFeedbackDownloadError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const manuallyStoppedRef = useRef(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);

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
    setFeedbackError(null);
    try {
      const response = await fetch(`${API_URL}/feedback`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: feedbackText }),
      });
      if (!response.ok) {
        setFeedbackError(`Save failed (status ${response.status}). Check your connection and try again.`);
        setFeedbackSaveStatus('idle');
        return;
      }
      setFeedbackSaveStatus('saved');
    } catch {
      setFeedbackError('Save failed. Check your connection and try again.');
      setFeedbackSaveStatus('idle');
    }
  }

  async function downloadFeedbackCsv(url: string) {
    setFeedbackDownloadError(null);
    try {
      const response = await fetch(url, { method: 'POST' });
      if (!response.ok) {
        setFeedbackDownloadError(`Download failed (status ${response.status}). Check your connection and try again.`);
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
      setFeedbackDownloadError('Download failed. Check your connection and try again.');
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
    const confirmed = window.confirm(`Flagged: "${line.reason ?? 'no reason given'}". Send this line to viewers?`);
    if (!confirmed) return;
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

  return (
    <main className="min-h-screen flex flex-col items-center gap-6 p-6">
      <h1 className="text-xl font-semibold">Sermon Capture</h1>

      <div className="w-full max-w-xl flex flex-col gap-2">
        <label className="text-sm font-medium">Sermon document (optional, PDF or Word)</label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx"
          onChange={onFileSelected}
          disabled={status === 'recording' || status === 'reconnecting' || isUploading}
        />
        {isUploading && <p className="text-sm text-muted-foreground">Uploading…</p>}
        {hasUploadedDoc && !isUploading && <p className="text-sm text-green-600">Document loaded.</p>}
        {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
      </div>

      <div className="flex gap-4">
        <button
          onClick={start}
          disabled={status === 'recording' || status === 'reconnecting'}
          className="bg-primary text-primary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          Start
        </button>
        <button
          onClick={stop}
          disabled={status === 'idle'}
          className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          Stop
        </button>
      </div>
      <p className="text-sm text-muted-foreground">Status: {status}</p>
      <p className="text-sm text-muted-foreground">
        Session: ${sessionCostUsd.toFixed(4)} · Lifetime: ${lifetimeCostUsd.toFixed(2)}
      </p>
      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
      <div className="relative w-full max-w-xl">
        {!isFollowing && (
          <button
            onClick={jumpToLatest}
            className="absolute bottom-2 right-2 z-10 bg-primary text-primary-foreground px-3 py-1 rounded text-xs shadow"
          >
            Jump to latest
          </button>
        )}
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className="w-full h-64 overflow-y-auto border rounded p-3 text-sm space-y-2"
        >
        {transcriptLines.map((line) => (
          <div key={line.id} className="group">
            <div className="flex items-start justify-between gap-2">
              <p className={line.flagged ? 'text-destructive line-through' : undefined}>{line.text}</p>
              {!line.flagged && (
                <button
                  onClick={() => sendAdminRemove(line.id)}
                  disabled={status !== 'recording' || line.removeState === 'pending'}
                  className="opacity-0 group-hover:opacity-100 text-xs underline text-destructive shrink-0 disabled:opacity-50"
                >
                  {line.removeState === 'pending' ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
            {line.flagged && line.reinstateState !== 'editing' && (
              <div className="flex items-center gap-2 text-xs">
                {line.reason && <span className="text-muted-foreground">Flagged: {line.reason}</span>}
                <button
                  onClick={() => beginEditing(line.id, line.text)}
                  disabled={status !== 'recording' || line.reinstateState === 'pending'}
                  className="underline disabled:opacity-50 disabled:no-underline"
                >
                  {line.reinstateState === 'pending' ? 'Reinstating…' : 'Reinstate'}
                </button>
              </div>
            )}
            {line.flagged && line.reinstateState === 'editing' && status === 'recording' && (
              <div className="flex flex-col gap-1 mt-1">
                <textarea
                  value={line.editedText ?? line.text}
                  onChange={(event) => updateEditedText(line.id, event.target.value)}
                  rows={2}
                  className="w-full border rounded p-1 text-xs"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => sendReinstate(line.id)}
                    disabled={(line.editedText ?? line.text).trim().length === 0}
                    className="bg-primary text-primary-foreground px-2 py-1 rounded text-xs disabled:opacity-50"
                  >
                    Send
                  </button>
                  <button onClick={() => cancelEditing(line.id)} className="text-xs underline">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {line.reinstateState === 'error' && (
              <p className="text-xs text-destructive">Couldn&apos;t reinstate ({line.reinstateError}) — try again.</p>
            )}
            {line.removeState === 'error' && (
              <p className="text-xs text-destructive">Couldn&apos;t remove ({line.removeError}) — try again.</p>
            )}
          </div>
        ))}
        </div>
      </div>

      <div className="w-full max-w-xl flex flex-col gap-2">
        <label className="text-sm font-medium">Feedback notes (optional)</label>
        <textarea
          value={feedbackText}
          onChange={(event) => {
            setFeedbackText(event.target.value);
            setFeedbackSaveStatus('idle');
          }}
          rows={6}
          className="w-full border rounded p-2 text-sm"
          placeholder="Notes about past translation accuracy issues, e.g. names that were missed…"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={saveFeedback}
            disabled={feedbackSaveStatus === 'saving'}
            className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
          >
            Save feedback notes
          </button>
          {feedbackSaveStatus === 'saved' && <p className="text-sm text-green-600">Saved.</p>}
        </div>
        {feedbackError && <p className="text-sm text-destructive">{feedbackError}</p>}
      </div>

      <div className="w-full max-w-xl flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-sm font-medium">Viewer feedback</label>
          <button
            onClick={downloadAllUndownloadedFeedback}
            disabled={viewerFeedback.every((item) => item.downloaded)}
            className="bg-secondary text-secondary-foreground px-3 py-1 rounded text-sm disabled:opacity-50"
          >
            Download all undownloaded ({viewerFeedback.filter((item) => !item.downloaded).length} new)
          </button>
        </div>
        {feedbackDownloadError && <p className="text-sm text-destructive">{feedbackDownloadError}</p>}
        {viewerFeedback.length === 0 ? (
          <p className="text-sm text-muted-foreground">No feedback yet.</p>
        ) : (
          <div className="border rounded divide-y max-h-80 overflow-y-auto text-sm">
            {viewerFeedback.map((item) => (
              <div key={item.id} className="p-2 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {new Date(item.timestamp).toLocaleString()} · {item.language}
                    {item.downloaded ? ' · downloaded' : ' · new'}
                  </span>
                  <button onClick={() => downloadFeedbackItem(item.id)} className="text-xs underline">
                    Download
                  </button>
                </div>
                <p className="text-muted-foreground">{item.english}</p>
                <p>{item.translated}</p>
                {item.comment && <p className="italic">&quot;{item.comment}&quot;</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
