'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatEntry, collapseRuns, type LogEntry as FormatLogEntry, type LogRow } from '@/lib/logFormat';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type GeminiModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';
type Provider = 'gemini' | 'openrouter';
type OpenRouterReasoningEffort = 'off' | 'low' | 'medium' | 'high';
type RoleModelSelection =
  | { provider: 'gemini'; model: GeminiModelId }
  | { provider: 'openrouter'; model: string; reasoning?: OpenRouterReasoningEffort };
type Role = 'transcriptionVerifier' | 'translation' | 'translationVerifier';

interface ModelConfig {
  transcriptionVerifier: RoleModelSelection;
  translation: RoleModelSelection;
  translationVerifier: RoleModelSelection;
}

interface PromptConfig {
  transcriptionVerifier: string;
  translation: string;
  translationVerifier: string;
}

type TranslationFlagDisplayMode = 'hide' | 'flag';

interface TranslationFlagDisplayConfig {
  mode: TranslationFlagDisplayMode;
}

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event?: string;
  [key: string]: unknown;
}

const CLIENT_LOG_CAP = 2000;

function capEntries(entries: LogEntry[]): LogEntry[] {
  return entries.length > CLIENT_LOG_CAP ? entries.slice(entries.length - CLIENT_LOG_CAP) : entries;
}

const ROLE_LABELS: Record<Role, string> = {
  transcriptionVerifier: 'Transcription verifier',
  translation: 'Translation',
  translationVerifier: 'Translation verifier',
};

const ROLES: Role[] = ['transcriptionVerifier', 'translation', 'translationVerifier'];
const GEMINI_MODEL_IDS: GeminiModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];
const REASONING_EFFORTS: OpenRouterReasoningEffort[] = ['off', 'low', 'medium', 'high'];
const REASONING_LABELS: Record<OpenRouterReasoningEffort, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const LEVEL_ROW_CLASS: Record<LogEntry['level'], string> = {
  info: 'text-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};

// Severity as a border stripe as well as text colour: amber text alone
// disappears the moment a row wraps.
const SEVERITY_BORDER: Record<LogEntry['level'], string> = {
  info: 'border-transparent',
  warn: 'border-amber-400',
  error: 'border-red-400',
};
const SEVERITY_GLYPH: Record<LogEntry['level'], string> = { info: '●', warn: '⚠', error: '✕' };

type LogViewMode = 'simple' | 'detailed' | 'raw';

function formatRawEntry(entry: LogEntry): string {
  const { timestamp, level, event, ...rest } = entry;
  const restText = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
  return `${timestamp} [${level}] ${event ?? ''}${restText}`.trimEnd();
}

interface LogFileInfo {
  name: string;
  kind: 'session' | 'server' | 'legacy';
  startedAt: string | null;
  endedAt: string | null;
  bytes: number;
  active: boolean;
}

const MELBOURNE = 'Australia/Melbourne';

function melbourneDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', {
    timeZone: MELBOURNE, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

function melbourneTimeLabel(iso: string, withSeconds = false): string {
  return new Date(iso).toLocaleTimeString('en-AU', {
    timeZone: MELBOURNE, hour: 'numeric', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
}

// en-CA conveniently formats as YYYY-MM-DD, matching <input type="date">'s
// value format, so this can be compared lexicographically against fromDate.
function melbourneIsoDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MELBOURNE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

function fileLabel(file: LogFileInfo): string {
  if (file.kind === 'server') return 'Server (idle events)';
  if (file.kind === 'legacy') return 'Legacy — everything before the split';
  if (!file.startedAt) return file.name;
  const start = melbourneDateLabel(file.startedAt) + ', ' + melbourneTimeLabel(file.startedAt);
  return file.endedAt ? `${start} – ${melbourneTimeLabel(file.endedAt)}` : start;
}

function durationLabel(file: LogFileInfo): string {
  if (!file.startedAt || !file.endedAt) return '';
  const ms = Date.parse(file.endedAt) - Date.parse(file.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function bytesLabel(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function fileSubLabel(file: LogFileInfo): string {
  return [durationLabel(file), bytesLabel(file.bytes)].filter(Boolean).join(' · ');
}

export default function AdminPage() {
  const [passcode, setPasscode] = useState('');
  const [enteredPasscode, setEnteredPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(false);

  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
  const [modelSaveStatus, setModelSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const [notes, setNotes] = useState<PromptConfig | null>(null);
  const [fixedRules, setFixedRules] = useState<PromptConfig | null>(null);
  const [notesSaveStatus, setNotesSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const [displayConfig, setDisplayConfig] = useState<TranslationFlagDisplayConfig | null>(null);
  const [displaySaveStatus, setDisplaySaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const [openRouterModels, setOpenRouterModels] = useState<string[]>([]);
  const [newModelInputs, setNewModelInputs] = useState<Record<Role, string>>({
    transcriptionVerifier: '',
    translation: '',
    translationVerifier: '',
  });

  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logStatus, setLogStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const logScrollRef = useRef<HTMLDivElement>(null);
  const [levelFilter, setLevelFilter] = useState<Record<LogEntry['level'], boolean>>({
    info: true,
    warn: true,
    error: true,
  });
  const [logSearch, setLogSearch] = useState('');
  const [logsPaused, setLogsPaused] = useState(false);
  const [logViewMode, setLogViewMode] = useState<LogViewMode>('simple');
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [openPayload, setOpenPayload] = useState<string | null>(null);

  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([]);
  const [selectedLog, setSelectedLog] = useState<string>('live');
  const [fileEntries, setFileEntries] = useState<FormatLogEntry[]>([]);
  const [fileMeta, setFileMeta] = useState<{ total: number; skipped: number; unparseable: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sortNewestFirst, setSortNewestFirst] = useState(true);
  const [fromDate, setFromDate] = useState('');
  const [pendingDelete, setPendingDelete] = useState<LogFileInfo | null>(null);

  const isLive = selectedLog === 'live';

  const visibleLogFiles = useMemo(() => {
    // Bucket by Melbourne calendar day, not the UTC instant in startedAt — a
    // file with no startedAt is excluded whenever a date filter is active,
    // explicitly (rather than as an accident of comparing against '').
    const filtered = logFiles.filter(
      (file) => !fromDate || (file.startedAt !== null && melbourneIsoDate(file.startedAt) >= fromDate)
    );
    return [...filtered].sort((a, b) => {
      const left = a.startedAt ? Date.parse(a.startedAt) : 0;
      const right = b.startedAt ? Date.parse(b.startedAt) : 0;
      return sortNewestFirst ? right - left : left - right;
    });
  }, [logFiles, fromDate, sortNewestFirst]);

  // Live streams from the WS buffer; a historical selection reads the file
  // loaded by the effect below. Both share the same LogEntry shape.
  const sourceEntries: LogEntry[] = isLive ? logEntries : fileEntries;

  const visibleLogRows = useMemo<LogRow[]>(() => {
    const search = logSearch.trim().toLowerCase();
    const kept = sourceEntries.filter((entry) => {
      if (!levelFilter[entry.level]) return false;
      if (logViewMode === 'simple' && !formatEntry(entry).simple) return false;
      if (!search) return true;
      return `${entry.event ?? ''} ${formatEntry(entry).text} ${JSON.stringify(entry)}`.toLowerCase().includes(search);
    });
    if (logViewMode !== 'simple') {
      return kept.map((entry) => ({ kind: 'one' as const, entry, count: 1, from: entry.timestamp, to: entry.timestamp, items: [entry] }));
    }
    return collapseRuns(kept);
  }, [sourceEntries, levelFilter, logSearch, logViewMode]);

  // Sum of row counts equals the filtered-entry count even in Simple mode,
  // where a run row's `count` folds several entries into one row.
  const matchedEntryCount = visibleLogRows.reduce((sum, row) => sum + row.count, 0);

  function visibleLogText(): string {
    return visibleLogRows
      .map((row) => (logViewMode === 'raw'
        ? formatRawEntry(row.entry)
        : `${melbourneTimeLabel(row.entry.timestamp, true)}  ${formatEntry(row.entry).text}${row.kind === 'run' ? ` (×${row.count})` : ''}`))
      .join('\n');
  }

  useEffect(() => {
    const stored = window.sessionStorage.getItem('adminPasscode');
    if (stored) {
      void loadAll(stored);
    }
  }, []);

  useEffect(() => {
    if (!authorized || passcode.length === 0) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closedByEffect = false;
    let attempts = 0;

    function connect() {
      socket = new WebSocket(`${WS_URL}/ws/logs?passcode=${encodeURIComponent(passcode)}`);

      socket.onopen = () => {
        attempts = 0;
        setLogStatus('connected');
      };

      socket.onmessage = (event) => {
        let message: { type?: string; entries?: LogEntry[]; entry?: LogEntry };
        try {
          message = JSON.parse(event.data as string);
        } catch {
          return; // ignore a malformed frame
        }
        if (message.type === 'history') {
          // A (re)connect delivers the current server buffer; replace the view
          // with it so a reconnect after a server restart self-heals without
          // duplicating entries.
          setLogEntries(capEntries(message.entries as LogEntry[]));
        } else if (message.type === 'log') {
          setLogEntries((prev) => capEntries([...prev, message.entry as LogEntry]));
        }
      };

      socket.onclose = () => {
        if (closedByEffect) return;
        setLogStatus('reconnecting');
        attempts += 1;
        const backoff = Math.min(1000 * 2 ** (attempts - 1), 10000);
        reconnectTimer = setTimeout(connect, backoff);
      };

      socket.onerror = () => {
        socket?.close();
      };
    }

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [authorized, passcode]);

  useEffect(() => {
    // Auto-follow-to-bottom is a live-tail concept; a historical file is
    // being browsed, not tailed, so leave the scroll position alone.
    if (!isLive || logsPaused) return;
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [isLive, visibleLogRows, logsPaused]);

  const refreshLogFiles = useCallback(async () => {
    const response = await fetch(`${API_URL}/admin/logs`, { headers: { 'x-admin-passcode': passcode } });
    if (!response.ok) return;
    const body = (await response.json()) as { files: LogFileInfo[] };
    setLogFiles(body.files);
  }, [passcode]);

  useEffect(() => {
    if (!authorized) return;
    // Calling the useCallback-memoized refreshLogFiles directly here trips
    // react-hooks/set-state-in-effect (it can see straight through to the
    // setLogFiles call). A fresh, uncaptured async closure sidesteps that
    // while doing exactly the same fetch.
    void (async () => {
      const response = await fetch(`${API_URL}/admin/logs`, { headers: { 'x-admin-passcode': passcode } });
      if (!response.ok) return;
      const body = (await response.json()) as { files: LogFileInfo[] };
      setLogFiles(body.files);
    })();
  }, [authorized, passcode]);

  useEffect(() => {
    if (!authorized || isLive) return;
    let cancelled = false;
    void (async () => {
      setFileLoading(true);
      setFileError(null);
      try {
        const response = await fetch(`${API_URL}/admin/logs/${encodeURIComponent(selectedLog)}`, {
          headers: { 'x-admin-passcode': passcode },
        });
        if (!response.ok) throw new Error(response.status === 404 ? 'That log is no longer on the server.' : 'Could not load that log.');
        const body = (await response.json()) as { entries: FormatLogEntry[]; total: number; skipped: number; unparseable: number };
        if (cancelled) return;
        setFileEntries(body.entries);
        setFileMeta({ total: body.total, skipped: body.skipped, unparseable: body.unparseable });
      } catch (error) {
        if (cancelled) return;
        setFileEntries([]);
        setFileMeta(null);
        setFileError(error instanceof Error ? error.message : 'Could not load that log.');
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authorized, isLive, selectedLog, passcode]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    const response = await fetch(`${API_URL}/admin/logs/${encodeURIComponent(pendingDelete.name)}`, {
      method: 'DELETE',
      headers: { 'x-admin-passcode': passcode },
    });
    if (response.status === 409) { toast.error('That session is still running.'); setPendingDelete(null); return; }
    if (response.status === 403) { toast.error('That log cannot be deleted.'); setPendingDelete(null); return; }
    if (!response.ok) { toast.error('Could not delete that log.'); setPendingDelete(null); return; }
    toast.success(`Deleted ${pendingDelete.name}`);
    if (selectedLog === pendingDelete.name) setSelectedLog('live');
    setPendingDelete(null);
    await refreshLogFiles();
  }

  async function loadAll(candidatePasscode: string) {
    setCheckingAuth(true);
    setAuthError(null);
    try {
      const [modelResponse, promptResponse, displayResponse, openRouterModelsResponse] = await Promise.all([
        fetch(`${API_URL}/admin/model-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/prompt-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/translation-flag-display`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/openrouter-models`, { headers: { 'x-admin-passcode': candidatePasscode } }),
      ]);

      if (
        modelResponse.status === 401 ||
        promptResponse.status === 401 ||
        displayResponse.status === 401 ||
        openRouterModelsResponse.status === 401
      ) {
        window.sessionStorage.removeItem('adminPasscode');
        setAuthorized(false);
        setAuthError('Incorrect passcode.');
        return;
      }

      setModelConfig(await modelResponse.json());
      const promptData = await promptResponse.json();
      setNotes(promptData.notes);
      setFixedRules(promptData.fixedRules);
      setDisplayConfig(await displayResponse.json());
      const openRouterModelsData = await openRouterModelsResponse.json();
      setOpenRouterModels(openRouterModelsData.models);

      window.sessionStorage.setItem('adminPasscode', candidatePasscode);
      setPasscode(candidatePasscode);
      setAuthorized(true);
    } catch {
      setAuthError('Could not reach the server. Check your connection and try again.');
    } finally {
      setCheckingAuth(false);
    }
  }

  function submitPasscode() {
    void loadAll(enteredPasscode);
  }

  async function saveModelConfig() {
    if (!modelConfig) return;
    setModelSaveStatus('saving');
    try {
      const response = await fetch(`${API_URL}/admin/model-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(modelConfig),
      });
      if (!response.ok) {
        toast.error(`Save failed (status ${response.status}).`);
        setModelSaveStatus('idle');
        return;
      }
      setModelSaveStatus('saved');
      toast.success('Models saved.');
    } catch {
      toast.error('Save failed. Check your connection and try again.');
      setModelSaveStatus('idle');
    }
  }

  async function addOpenRouterModel(role: Role) {
    const model = newModelInputs[role].trim();
    if (model.length === 0 || !modelConfig) return;
    try {
      const response = await fetch(`${API_URL}/admin/openrouter-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify({ model }),
      });
      if (!response.ok) return;
      const data = await response.json();
      setOpenRouterModels(data.models);
      setModelConfig({ ...modelConfig, [role]: { ...modelConfig[role], model } });
      setNewModelInputs({ ...newModelInputs, [role]: '' });
      setModelSaveStatus('idle');
    } catch {
      // Adding a model id is a convenience action; a network failure here just
      // leaves the input as-is for the admin to retry, same posture as the
      // existing save actions on this page.
    }
  }

  async function saveNotes() {
    if (!notes) return;
    setNotesSaveStatus('saving');
    try {
      const response = await fetch(`${API_URL}/admin/prompt-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(notes),
      });
      if (!response.ok) {
        toast.error(`Save failed (status ${response.status}).`);
        setNotesSaveStatus('idle');
        return;
      }
      setNotesSaveStatus('saved');
      toast.success('Prompt notes saved.');
    } catch {
      toast.error('Save failed. Check your connection and try again.');
      setNotesSaveStatus('idle');
    }
  }

  async function saveDisplayConfig() {
    if (!displayConfig) return;
    setDisplaySaveStatus('saving');
    try {
      const response = await fetch(`${API_URL}/admin/translation-flag-display`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(displayConfig),
      });
      if (!response.ok) {
        toast.error(`Save failed (status ${response.status}).`);
        setDisplaySaveStatus('idle');
        return;
      }
      setDisplaySaveStatus('saved');
      toast.success('Display setting saved.');
    } catch {
      toast.error('Save failed. Check your connection and try again.');
      setDisplaySaveStatus('idle');
    }
  }

  function copyLogs() {
    void navigator.clipboard.writeText(visibleLogText());
    toast.success('Logs copied.');
  }

  function downloadLogs() {
    const blob = new Blob([visibleLogText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadRawLogFile() {
    if (isLive) return;
    try {
      const response = await fetch(`${API_URL}/admin/logs/${encodeURIComponent(selectedLog)}`, {
        headers: { 'x-admin-passcode': passcode },
      });
      if (!response.ok) {
        toast.error('Could not download that log.');
        return;
      }
      // The untouched response body, not the parsed-and-reformatted entries
      // used on screen — this is the diagnostic escape hatch.
      const raw = await response.text();
      const blob = new Blob([raw], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${selectedLog.replace(/\.[^.]+$/, '')}-raw.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not download that log.');
    }
  }

  function clearLogs() {
    setLogEntries([]);
  }

  if (!authorized) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Admin access</CardTitle>
            <CardDescription>Enter the admin passcode to continue.</CardDescription>
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
    <main className="flex min-h-screen flex-col items-center gap-6 p-6">
      <h1 className="text-xl font-semibold">Admin</h1>
      <Tabs defaultValue="models" className="w-full max-w-2xl">
        <TabsList>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="notes">Prompt notes</TabsTrigger>
          <TabsTrigger value="display">Display</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="models" className="flex flex-col gap-4">
          {modelConfig &&
            ROLES.map((role) => {
              const selection = modelConfig[role];
              return (
                <Card key={role}>
                  <CardHeader>
                    <CardTitle>{ROLE_LABELS[role]}</CardTitle>
                    <CardAction>
                      <Select
                        value={selection.provider}
                        onValueChange={(value) => {
                          const provider = value as Provider;
                          const nextSelection: RoleModelSelection =
                            provider === 'gemini'
                              ? { provider: 'gemini', model: GEMINI_MODEL_IDS[0] }
                              : { provider: 'openrouter', model: openRouterModels[0] ?? '' };
                          setModelConfig({ ...modelConfig, [role]: nextSelection });
                          setModelSaveStatus('idle');
                        }}
                      >
                        <SelectTrigger className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="gemini">Gemini</SelectItem>
                            <SelectItem value="openrouter">OpenRouter</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {selection.provider === 'gemini' ? (
                      <Select
                        value={selection.model}
                        onValueChange={(value) => {
                          setModelConfig({
                            ...modelConfig,
                            [role]: { provider: 'gemini', model: value as GeminiModelId },
                          });
                          setModelSaveStatus('idle');
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {GEMINI_MODEL_IDS.map((id) => (
                              <SelectItem key={id} value={id}>
                                {id}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    ) : (
                      <>
                        <Select
                          value={selection.model}
                          onValueChange={(value) => {
                            setModelConfig({ ...modelConfig, [role]: { ...selection, model: value } });
                            setModelSaveStatus('idle');
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="No models added yet" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {openRouterModels.map((id) => (
                                <SelectItem key={id} value={id}>
                                  {id}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Thinking</span>
                          <ToggleGroup
                            value={[selection.reasoning ?? 'off']}
                            onValueChange={(values) => {
                              const value = values[0];
                              if (!value) return;
                              const reasoning = value as OpenRouterReasoningEffort;
                              setModelConfig({
                                ...modelConfig,
                                [role]: { ...selection, reasoning: reasoning === 'off' ? undefined : reasoning },
                              });
                              setModelSaveStatus('idle');
                            }}
                          >
                            {REASONING_EFFORTS.map((effort) => (
                              <ToggleGroupItem key={effort} value={effort} size="sm">
                                {REASONING_LABELS[effort]}
                              </ToggleGroupItem>
                            ))}
                          </ToggleGroup>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            value={newModelInputs[role]}
                            onChange={(event) => setNewModelInputs({ ...newModelInputs, [role]: event.target.value })}
                            placeholder="e.g. qwen/qwen3.6-flash"
                            className="flex-1"
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void addOpenRouterModel(role)}
                            disabled={newModelInputs[role].trim().length === 0}
                          >
                            Add
                          </Button>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          <div>
            <Button variant="secondary" onClick={saveModelConfig} disabled={modelSaveStatus === 'saving'}>
              Save models
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="notes" className="flex flex-col gap-6">
          {notes &&
            fixedRules &&
            ROLES.map((role) => (
              <div key={role} className="flex flex-col gap-2">
                <label className="text-sm font-medium">{ROLE_LABELS[role]}</label>
                <Alert>
                  <AlertDescription className="whitespace-pre-wrap">{fixedRules[role]}</AlertDescription>
                </Alert>
                <Textarea
                  value={notes[role]}
                  onChange={(event) => {
                    setNotes({ ...notes, [role]: event.target.value });
                    setNotesSaveStatus('idle');
                  }}
                  rows={4}
                />
              </div>
            ))}
          <div>
            <Button variant="secondary" onClick={saveNotes} disabled={notesSaveStatus === 'saving'}>
              Save notes
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="display" className="flex max-w-xl flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium">Unsafe translation display</h2>
            <p className="text-sm text-muted-foreground">
              Controls what viewers see when a translation fails its safety check.
            </p>
          </div>
          {displayConfig && (
            <RadioGroup
              value={displayConfig.mode}
              onValueChange={(value) => {
                setDisplayConfig({ mode: value as TranslationFlagDisplayMode });
                setDisplaySaveStatus('idle');
              }}
              className="flex flex-col gap-3"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="hide" id="display-hide" />
                <label htmlFor="display-hide" className="text-sm">
                  Hide (fallback to English)
                </label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="flag" id="display-flag" />
                <label htmlFor="display-flag" className="text-sm">
                  Show in viewer, marked red, with reason
                </label>
              </div>
            </RadioGroup>
          )}
          <div>
            <Button variant="secondary" onClick={saveDisplayConfig} disabled={displaySaveStatus === 'saving'}>
              Save display setting
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="logs" className="flex flex-col gap-3">
          {pendingDelete && (
            <Alert variant="destructive">
              <AlertDescription>
                Delete {fileLabel(pendingDelete)}? This cannot be undone.
              </AlertDescription>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="destructive" onClick={() => void confirmDelete()}>
                  Delete log
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPendingDelete(null)}>
                  Keep it
                </Button>
              </div>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger
                render={
                  <Button variant="secondary" size="sm" className="min-w-64 justify-start">
                    {isLive
                      ? 'Live — current session'
                      : fileLabel(
                          logFiles.find((f) => f.name === selectedLog) ?? {
                            name: selectedLog,
                            kind: 'session',
                            startedAt: null,
                            endedAt: null,
                            bytes: 0,
                            active: false,
                          }
                        )}
                  </Button>
                }
              />
              <PopoverContent className="w-96 p-1">
                <div className="flex items-center gap-2 border-b p-2">
                  <Input
                    type="date"
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                    aria-label="Show logs from this date onward"
                    className="h-8 flex-1"
                  />
                  <ToggleGroup
                    value={[sortNewestFirst ? 'new' : 'old']}
                    onValueChange={(values) => setSortNewestFirst(values[0] !== 'old')}
                  >
                    <ToggleGroupItem value="new" size="sm">Newest</ToggleGroupItem>
                    <ToggleGroupItem value="old" size="sm">Oldest</ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <ScrollArea className="max-h-72">
                  <button
                    type="button"
                    onClick={() => { setSelectedLog('live'); setPickerOpen(false); }}
                    className="flex w-full flex-col items-start rounded-sm px-2 py-2 text-left hover:bg-muted"
                  >
                    <span className="text-sm">Live — current session</span>
                    <span className="text-xs text-muted-foreground">Streaming from the server</span>
                  </button>
                  {visibleLogFiles.map((file) => (
                    <button
                      key={file.name}
                      type="button"
                      onClick={() => { setSelectedLog(file.name); setPickerOpen(false); }}
                      className="flex w-full flex-col items-start rounded-sm px-2 py-2 text-left hover:bg-muted"
                    >
                      <span className="text-sm">{fileLabel(file)}</span>
                      <span className="text-xs text-muted-foreground">{fileSubLabel(file)}</span>
                    </button>
                  ))}
                </ScrollArea>
              </PopoverContent>
            </Popover>

            <Button
              variant="secondary"
              size="sm"
              disabled={isLive || selectedLog === 'events.log'}
              onClick={() => setPendingDelete(logFiles.find((f) => f.name === selectedLog) ?? null)}
            >
              Delete
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              value={[logViewMode]}
              onValueChange={(values) => setLogViewMode(((values as string[])[0] ?? 'simple') as LogViewMode)}
            >
              <ToggleGroupItem value="simple" size="sm">Simple</ToggleGroupItem>
              <ToggleGroupItem value="detailed" size="sm">Detailed</ToggleGroupItem>
              <ToggleGroupItem value="raw" size="sm">Raw</ToggleGroupItem>
            </ToggleGroup>
            <ToggleGroup
              multiple
              value={(Object.keys(levelFilter) as LogEntry['level'][]).filter((level) => levelFilter[level])}
              onValueChange={(values) => {
                const active = new Set(values as LogEntry['level'][]);
                setLevelFilter({ info: active.has('info'), warn: active.has('warn'), error: active.has('error') });
              }}
            >
              <ToggleGroupItem value="info" size="sm">Normal</ToggleGroupItem>
              <ToggleGroupItem value="warn" size="sm">Attention</ToggleGroupItem>
              <ToggleGroupItem value="error" size="sm">Problems</ToggleGroupItem>
            </ToggleGroup>
            <Input
              value={logSearch}
              onChange={(event) => setLogSearch(event.target.value)}
              placeholder="Filter…"
              className="h-8 w-40"
            />
            <Button variant="secondary" size="sm" disabled={!isLive} onClick={() => setLogsPaused((paused) => !paused)}>
              {logsPaused ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="secondary" size="sm" onClick={clearLogs}>Clear</Button>
            <Button variant="secondary" size="sm" onClick={copyLogs}>Copy</Button>
            <Button variant="secondary" size="sm" onClick={downloadLogs}>Download</Button>
            {!isLive && (
              <Button variant="secondary" size="sm" onClick={() => void downloadRawLogFile()}>
                Download raw file
              </Button>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {isLive ? (
              <>
                {logStatus === 'connected' ? 'Live' : logStatus === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
                {logsPaused ? ' · Paused' : ''}
                {' · '}
                {matchedEntryCount} / {sourceEntries.length} entries
              </>
            ) : fileLoading ? (
              'Loading…'
            ) : fileError ? (
              <span className="text-destructive">{fileError}</span>
            ) : fileMeta ? (
              <>
                {matchedEntryCount} / {sourceEntries.length} entries loaded
                {fileMeta.skipped > 0 ? ` (of ${fileMeta.total} in the file)` : ''}
                {fileMeta.unparseable > 0 ? ` · ${fileMeta.unparseable} unparseable` : ''}
              </>
            ) : null}
          </div>
          <div
            ref={logScrollRef}
            className="h-[60vh] overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed"
          >
            {fileLoading && <div className="p-6 text-center text-muted-foreground">Loading…</div>}
            {fileError && <div className="p-6 text-center text-red-400">{fileError}</div>}
            {!fileLoading && !fileError && fileMeta && fileMeta.skipped > 0 && (
              <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300">
                Showing the most recent {(fileMeta.total - fileMeta.skipped).toLocaleString()} of {fileMeta.total.toLocaleString()} entries.
              </div>
            )}
            {!fileLoading && !fileError && fileMeta && fileMeta.unparseable > 0 && (
              <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300">
                {fileMeta.unparseable.toLocaleString()} line(s) could not be read and were skipped.
              </div>
            )}
            {!fileLoading && !fileError && visibleLogRows.length === 0 && (
              <div className="p-6 text-center text-muted-foreground">
                Nothing matches those filters. Try turning a severity back on, or clearing the search.
              </div>
            )}
            {!fileLoading && !fileError && visibleLogRows.map((row, index) => {
              const key = `${row.entry.event ?? 'x'}-${row.from}-${index}`;
              if (logViewMode === 'raw') {
                return (
                  <div key={key} className={`whitespace-pre-wrap break-all ${LEVEL_ROW_CLASS[row.entry.level] ?? LEVEL_ROW_CLASS.info}`}>
                    {formatRawEntry(row.entry)}
                  </div>
                );
              }
              const formatted = formatEntry(row.entry);
              const expanded = expandedRuns[key] ?? false;
              return (
                <div key={key}>
                  <button
                    type="button"
                    onClick={() => (row.kind === 'run'
                      ? setExpandedRuns((current) => ({ ...current, [key]: !expanded }))
                      : setOpenPayload((current) => (current === key ? null : key)))}
                    className={`flex w-full gap-2 border-l-2 px-2 py-1 text-left hover:bg-muted/40 ${SEVERITY_BORDER[row.entry.level]}`}
                  >
                    <span className="w-24 shrink-0 tabular-nums text-muted-foreground">
                      {melbourneTimeLabel(row.entry.timestamp, true)}
                    </span>
                    <span className={`w-4 shrink-0 ${LEVEL_ROW_CLASS[row.entry.level]}`}>{SEVERITY_GLYPH[row.entry.level]}</span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className={LEVEL_ROW_CLASS[row.entry.level]}>
                        {formatted.text}
                        {row.kind === 'run' && <span className="ml-2 rounded-full border px-1.5 text-[10px] text-muted-foreground">×{row.count}</span>}
                      </span>
                      {row.kind === 'run' && (
                        <span className="text-[11px] text-muted-foreground">
                          {row.count} times, {melbourneTimeLabel(row.from)} to {melbourneTimeLabel(row.to)} · {expanded ? 'hide' : 'show each one'}
                        </span>
                      )}
                    </span>
                  </button>
                  {row.kind === 'one' && openPayload === key && (
                    <pre className="my-1 overflow-x-auto rounded-md border bg-background p-2 text-[11px] text-muted-foreground">
                      {JSON.stringify(row.entry, null, 2)}
                    </pre>
                  )}
                  {row.kind === 'run' && expanded && row.items.map((item, itemIndex) => (
                    <div key={`${key}-${itemIndex}`} className="flex gap-2 px-2 py-0.5 pl-8 text-muted-foreground">
                      <span className="w-24 shrink-0 tabular-nums">{melbourneTimeLabel(item.timestamp, true)}</span>
                      <span className="min-w-0">{formatEntry(item).text}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}
