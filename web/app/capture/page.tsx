'use client';

import { useEffect, useRef, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type CaptureStatus = 'idle' | 'recording' | 'reconnecting' | 'error';

export default function CapturePage() {
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [transcriptLines, setTranscriptLines] = useState<{ text: string; flagged: boolean }[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasUploadedDoc, setHasUploadedDoc] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSaveStatus, setFeedbackSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const manuallyStoppedRef = useRef(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/feedback`)
      .then((response) => response.json())
      .then((data) => setFeedbackText(data.text ?? ''))
      .catch(() => setFeedbackText(''));
  }, []);

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
        setTranscriptLines((previous) => [
          ...previous.slice(-49),
          { text: message.english, flagged: Boolean(message.flagged) },
        ]);
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
      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
      <div className="w-full max-w-xl h-64 overflow-y-auto border rounded p-3 text-sm space-y-1">
        {transcriptLines.map((line, index) => (
          <p key={index} className={line.flagged ? 'text-destructive line-through' : undefined}>
            {line.text}
          </p>
        ))}
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
    </main>
  );
}
