'use client';

import { useEffect, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
const API_URL = WS_URL.replace(/^ws/, 'http');

type ModelId = 'gemini-3.1-flash-lite' | 'gemini-3.5-flash';
type Role = 'transcriptionVerifier' | 'translation' | 'translationVerifier';

interface ModelConfig {
  transcriptionVerifier: ModelId;
  translation: ModelId;
  translationVerifier: ModelId;
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

const ROLE_LABELS: Record<Role, string> = {
  transcriptionVerifier: 'Transcription verifier',
  translation: 'Translation',
  translationVerifier: 'Translation verifier',
};

const ROLES: Role[] = ['transcriptionVerifier', 'translation', 'translationVerifier'];
const MODEL_IDS: ModelId[] = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];

export default function AdminPage() {
  const [passcode, setPasscode] = useState('');
  const [enteredPasscode, setEnteredPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(false);

  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
  const [modelSaveStatus, setModelSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [modelError, setModelError] = useState<string | null>(null);

  const [notes, setNotes] = useState<PromptConfig | null>(null);
  const [fixedRules, setFixedRules] = useState<PromptConfig | null>(null);
  const [notesSaveStatus, setNotesSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [notesError, setNotesError] = useState<string | null>(null);

  const [displayConfig, setDisplayConfig] = useState<TranslationFlagDisplayConfig | null>(null);
  const [displaySaveStatus, setDisplaySaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [displayError, setDisplayError] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.sessionStorage.getItem('adminPasscode');
    if (stored) {
      setPasscode(stored);
      void loadAll(stored);
    }
  }, []);

  async function loadAll(candidatePasscode: string) {
    setCheckingAuth(true);
    setAuthError(null);
    try {
      const [modelResponse, promptResponse, displayResponse] = await Promise.all([
        fetch(`${API_URL}/admin/model-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/prompt-config`, { headers: { 'x-admin-passcode': candidatePasscode } }),
        fetch(`${API_URL}/admin/translation-flag-display`, { headers: { 'x-admin-passcode': candidatePasscode } }),
      ]);

      if (modelResponse.status === 401 || promptResponse.status === 401 || displayResponse.status === 401) {
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
    setModelError(null);
    try {
      const response = await fetch(`${API_URL}/admin/model-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(modelConfig),
      });
      if (!response.ok) {
        setModelError(`Save failed (status ${response.status}).`);
        setModelSaveStatus('idle');
        return;
      }
      setModelSaveStatus('saved');
    } catch {
      setModelError('Save failed. Check your connection and try again.');
      setModelSaveStatus('idle');
    }
  }

  async function saveNotes() {
    if (!notes) return;
    setNotesSaveStatus('saving');
    setNotesError(null);
    try {
      const response = await fetch(`${API_URL}/admin/prompt-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(notes),
      });
      if (!response.ok) {
        setNotesError(`Save failed (status ${response.status}).`);
        setNotesSaveStatus('idle');
        return;
      }
      setNotesSaveStatus('saved');
    } catch {
      setNotesError('Save failed. Check your connection and try again.');
      setNotesSaveStatus('idle');
    }
  }

  async function saveDisplayConfig() {
    if (!displayConfig) return;
    setDisplaySaveStatus('saving');
    setDisplayError(null);
    try {
      const response = await fetch(`${API_URL}/admin/translation-flag-display`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(displayConfig),
      });
      if (!response.ok) {
        setDisplayError(`Save failed (status ${response.status}).`);
        setDisplaySaveStatus('idle');
        return;
      }
      setDisplaySaveStatus('saved');
    } catch {
      setDisplayError('Save failed. Check your connection and try again.');
      setDisplaySaveStatus('idle');
    }
  }

  if (!authorized) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
        <h1 className="text-xl font-semibold">Admin</h1>
        <input
          type="password"
          value={enteredPasscode}
          onChange={(event) => setEnteredPasscode(event.target.value)}
          placeholder="Passcode"
          className="border rounded p-2 text-sm w-64"
          disabled={checkingAuth}
        />
        <button
          onClick={submitPasscode}
          disabled={checkingAuth || enteredPasscode.length === 0}
          className="bg-primary text-primary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          {checkingAuth ? 'Checking…' : 'Enter'}
        </button>
        {authError && <p className="text-sm text-destructive">{authError}</p>}
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col items-center gap-8 p-6">
      <h1 className="text-xl font-semibold">Admin</h1>

      <div className="w-full max-w-xl flex flex-col gap-3">
        <h2 className="text-lg font-medium">Models</h2>
        {modelConfig &&
          ROLES.map((role) => (
            <div key={role} className="flex items-center justify-between gap-2">
              <label className="text-sm font-medium">{ROLE_LABELS[role]}</label>
              <select
                value={modelConfig[role]}
                onChange={(event) => {
                  setModelConfig({ ...modelConfig, [role]: event.target.value as ModelId });
                  setModelSaveStatus('idle');
                }}
                className="border rounded p-1 text-sm"
              >
                {MODEL_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          ))}
        <div className="flex items-center gap-3">
          <button
            onClick={saveModelConfig}
            disabled={modelSaveStatus === 'saving'}
            className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
          >
            Save models
          </button>
          {modelSaveStatus === 'saved' && <p className="text-sm text-green-600">Saved.</p>}
        </div>
        {modelError && <p className="text-sm text-destructive">{modelError}</p>}
      </div>

      <div className="w-full max-w-xl flex flex-col gap-6">
        <h2 className="text-lg font-medium">Prompt notes</h2>
        {notes &&
          fixedRules &&
          ROLES.map((role) => (
            <div key={role} className="flex flex-col gap-2">
              <label className="text-sm font-medium">{ROLE_LABELS[role]}</label>
              <p className="text-xs text-muted-foreground border rounded p-2 bg-accent/20 whitespace-pre-wrap">
                {fixedRules[role]}
              </p>
              <textarea
                value={notes[role]}
                onChange={(event) => {
                  setNotes({ ...notes, [role]: event.target.value });
                  setNotesSaveStatus('idle');
                }}
                rows={4}
                className="w-full border rounded p-2 text-sm"
              />
            </div>
          ))}
        <div className="flex items-center gap-3">
          <button
            onClick={saveNotes}
            disabled={notesSaveStatus === 'saving'}
            className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
          >
            Save notes
          </button>
          {notesSaveStatus === 'saved' && <p className="text-sm text-green-600">Saved.</p>}
        </div>
        {notesError && <p className="text-sm text-destructive">{notesError}</p>}
      </div>

      <div className="w-full max-w-xl flex flex-col gap-3">
        <h2 className="text-lg font-medium">Unsafe translation display</h2>
        {displayConfig && (
          <div className="flex flex-col gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="translationFlagDisplayMode"
                checked={displayConfig.mode === 'hide'}
                onChange={() => {
                  setDisplayConfig({ mode: 'hide' });
                  setDisplaySaveStatus('idle');
                }}
              />
              Hide (fallback to English)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="translationFlagDisplayMode"
                checked={displayConfig.mode === 'flag'}
                onChange={() => {
                  setDisplayConfig({ mode: 'flag' });
                  setDisplaySaveStatus('idle');
                }}
              />
              Show in viewer, marked red, with reason
            </label>
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={saveDisplayConfig}
            disabled={displaySaveStatus === 'saving'}
            className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
          >
            Save display setting
          </button>
          {displaySaveStatus === 'saved' && <p className="text-sm text-green-600">Saved.</p>}
        </div>
        {displayError && <p className="text-sm text-destructive">{displayError}</p>}
      </div>
    </main>
  );
}
