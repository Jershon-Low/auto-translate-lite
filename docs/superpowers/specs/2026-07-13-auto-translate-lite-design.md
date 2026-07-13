# Auto Translate Lite — Design

## Purpose

Live speech-to-text and translation for church services. A preacher speaks English; congregation members scan a QR code on the LED wall, pick their language, and see translated captions on their phone with up to ~5 seconds of latency.

## Scale & Scope

- ~50 concurrent viewers, 10+ target languages, one active session at a time (architecture leaves room to extend to multiple concurrent sessions later, but that's out of scope now).
- Source language is always English for now; the design keeps source-language swap-in possible later (see Future Extensions).
- Cloud-hosted (small VPS), so audio capture happens on-site and is streamed up to the server.

## Architecture Overview

Three components:

1. **Capture page** — a browser page opened by an AV volunteer on a laptop connected to the soundboard (or with a mic nearby). Captures audio and streams it to the server. No language selection here; its only job is capturing audio and giving the volunteer a Start/Stop control with status feedback.
2. **Server** (Node.js/TypeScript, on a VPS) — receives the audio stream, transcribes it via Deepgram, translates finalized segments via Gemini, holds session/buffer state in memory, and fans out translated captions to viewers over WebSocket.
3. **Viewer page** — reached via the QR code. Language picker → scrollable live caption feed.

```
Capture page --(audio via WebSocket)--> Server --(streaming audio)--> Deepgram
                                           |
                                    (finalized English segment)
                                           |
                                           v
                                   Gemini (single call per
                                   segment, structured JSON,
                                   only active languages)
                                           |
                                           v
                              Server broadcasts {english, translated}
                              line to viewers subscribed to that language
                                           |
                                           v
                                    Viewer page (per language)
```

## Key Design Decisions

### Audio → Deepgram: proxied through the server
The capture page sends raw audio to the server over WebSocket; the server forwards it to Deepgram's streaming API. This keeps the Deepgram API key server-side only — it's never exposed in client-side JS.

### Translation fan-out: one Gemini call per sentence, all active languages at once
When Deepgram finalizes a segment (not interim/in-progress results), the server sends one Gemini request asking for translations into every target language that currently has at least one connected viewer, using structured JSON output (e.g. `{"zh": "...", "id": "...", "ko": "..."}`). Languages with no active viewers aren't translated, so cost scales with actual usage, not the full fixed list.

This keeps API usage to one call per sentence regardless of how many languages are active, comfortably within the 5-second latency budget, and avoids the cost/rate-limit risk of firing 10+ parallel Gemini calls per sentence.

### Rolling transcript buffer + on-demand backlog translation
The server keeps a rolling buffer of the last 10 minutes of finalized English segments. When a viewer selects a language — either on first join or by switching languages — the server translates the current backlog into that language in one batch call and sends it as scrollback history, then continues with live updates from that point on. This avoids a blank screen for someone joining a few minutes into the sermon.

### Caption format: English original + translation together
Each caption line carries both the original English segment and its translation as a pair, not just the translated text. The viewer page renders the grey, muted English line above the full-size translated line beneath it. This applies both to live lines and to backlog/scrollback lines.

## Session Lifecycle

- Server holds one "current session" in memory, keyed internally by a session ID (not exposed in the UI now, but avoids a redesign if multiple concurrent sessions are needed later).
- Volunteer clicks **Start** on the capture page → server creates a new session (fresh session ID), clears the transcript buffer, opens a Deepgram streaming connection.
- Volunteer clicks **Stop** → server ends the Deepgram stream and marks the session inactive. The buffer is retained until the next Start (so a viewer mid-scrollback isn't cut off), but no new segments are appended while stopped.
- No database — everything lives in server memory. A server restart loses the current session; the volunteer just clicks Start again. Acceptable at this scale and stakes.

## Data Flow (step by step)

1. Volunteer opens capture page, clicks Start. Browser requests mic access, opens a WebSocket to the server, and streams audio.
2. Server pipes that audio into a Deepgram streaming connection.
3. Deepgram returns interim results (ignored) and finalized segments. Each finalized segment is appended to the session's English transcript buffer.
4. Server determines the current set of actively-viewed languages, sends one Gemini request for that segment covering exactly those languages.
5. Server broadcasts each `{english, translated}` line to viewers subscribed to that language over WebSocket.
6. Viewer flow: scan QR → landing page lists fixed target languages → pick one (remembered in `localStorage` for next time) → server translates the current backlog on demand for that language and sends it as scrollback → live lines append from then on.
7. Switching languages mid-session re-runs the on-demand backlog translation for the newly selected language.

## Viewer UI

- **Landing/language-select page**: mobile-first, large tap targets for each fixed target language. Selecting one navigates to the caption view and remembers the choice in `localStorage`.
- **Caption view**: dark background by default, large legible text. New lines append at the bottom with auto-scroll; if the viewer manually scrolls up, auto-scroll pauses and a "Jump to latest ↓" button appears. Status line handles "Waiting for the service to start…" (no active session) and "Reconnecting…" (WebSocket dropped). Each caption block shows the grey English original above the full-size translated line.

## Capture Page UI (volunteer-facing)

- Start/Stop control.
- Status indicator: Idle / Recording / Reconnecting / Error.
- A rolling view of the raw English transcript, so the volunteer can visually confirm speech is being picked up correctly.

## Error Handling

- **Capture WebSocket drops**: capture page auto-reconnects and re-establishes the Deepgram stream. A short transcript gap is acceptable; the volunteer sees the status indicator change.
- **Gemini call fails for a segment**: retry once, then skip that line and log the error server-side. Viewers miss one sentence rather than the session breaking.
- **Server restart**: session state is lost (in-memory only); volunteer restarts by clicking Start again. No persistence/recovery complexity is built for this.

## Testing & Verification

- **Unit tests**: transcript buffer (append/cap/trim), Gemini request/response handling (prompt construction, structured JSON parsing, handling malformed/failed responses), WebSocket fan-out (only active languages get translated; viewers only receive their subscribed language).
- **Manual end-to-end verification**: run the capture page against a recorded sermon clip (or live mic) and confirm captions arrive across a few target languages within the 5-second budget, and that a viewer joining mid-stream gets sensible scrollback.
- Transcription/translation *quality* itself (Deepgram/Gemini accuracy) is not something this codebase tests — that's inherent to the third-party services.

## Tech Stack

- **Backend**: Node.js + TypeScript, `ws` (WebSocket), Express for serving the capture/viewer pages, Deepgram Node SDK, Gemini API SDK (structured/JSON output mode).
- **Frontend**: plain browser JS/TS for both capture and viewer pages (no framework needed at this scale).
- **Hosting**: small cloud VPS. Since nothing is provisioned yet, the implementation plan will include setup guidance for the VPS, domain, Deepgram API key, and Gemini API key.

## Future Extensions (explicitly out of scope now)

- Multiple concurrent sessions (different campuses/rooms running independently) — session-ID structure is already in place to support this later without a redesign.
- Selectable/detected source language (currently hardcoded to English).
- Fully open target language selection (currently a fixed preset list).
- Local Whisper as a swap-in alternative to Deepgram for transcription.
