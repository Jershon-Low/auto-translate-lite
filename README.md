# Auto Translate Lite

Live speech-to-text and translation for church services. A preacher speaks English; congregation members scan a QR code on the LED wall, pick their language, and see translated captions on their phone within seconds.

See [`docs/superpowers/specs/2026-07-13-auto-translate-lite-design.md`](docs/superpowers/specs/2026-07-13-auto-translate-lite-design.md) for the full design and [`docs/DEPLOY.md`](docs/DEPLOY.md) for production deployment.

## How it works

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
```

- **Capture page** — an AV volunteer's laptop streams mic/soundboard audio to the server. No language selection; just Start/Stop and a live status indicator.
- **Server** (Node.js/TypeScript) — transcribes via Deepgram (`nova-3`), translates finalized sentences via Gemini, and fans out captions to viewers over WebSocket. Everything lives in memory — no database.
- **Viewer page** — reached via QR code. Pick a language, see live captions with the English original shown above each translated line.

Translation cost scales with *actual* usage: only languages with a connected viewer are translated, in one Gemini call per sentence covering every active language at once — not one call per language.

## Safety features

Live, unreviewed machine translation in front of a congregation carries real risk: a mistranslation could invert a statement's meaning or misrepresent what's said about God, Jesus, or the Holy Spirit. This isn't a generic profanity filter — it's a domain-specific meaning-preservation check:

- **Theological/polarity safety checker** ([`translationVerifier.ts`](server/src/translationVerifier.ts)) — every translation is checked by a second Gemini call before it reaches a viewer. It flags translations that invert positive↔negative meaning, negate or contradict the original, reverse who's doing/receiving an action, or misrepresent God/Jesus/the Holy Spirit.
- **Fail-safe fallback, not fail-open** — if a translation is flagged unsafe (or the safety check itself fails), the viewer sees the **English original** instead of a suspect translation. The system never ships a translation it couldn't verify.
- **Idiom-aware, not over-cautious** — the checker is explicitly told not to flag natural, non-literal renderings of Australian slang and idiom ("no worries," "arvo," "having a go"), so it catches real meaning errors without constantly falling back to English.
- **Audit logging** — every discarded/unsafe translation is logged server-side as structured JSON (language, original, discarded translation, reason), so mistranslation patterns can be reviewed after a service.
- **Graceful degradation on API failure** — Gemini calls are retried once; if translation or verification still fails, that single sentence is skipped (or shown in English) rather than breaking the session for everyone.
- **API keys never reach the browser** — Deepgram and Gemini keys live only in server-side env vars. The capture page only ever sends raw audio over its own WebSocket; the server proxies it to Deepgram.
- **Minimal attack surface** — the WebSocket upgrade handler only accepts two known paths (`/ws/capture`, `/ws/viewer`); everything else is destroyed at the socket level. No accounts, no auth tokens, no PII collected or stored anywhere.
- **No persistent data** — session/transcript state is in-memory only and cleared on restart. Nothing about who watched or what language they picked is retained.
- **Deployment hardening** ([`docs/DEPLOY.md`](docs/DEPLOY.md)) — HTTPS everywhere via automatic Let's Encrypt certs (Caddy), SSH restricted to a single admin IP, only 80/443/22 open, `/health` endpoint for uptime checks.

## Cost analysis

Both external APIs are pay-as-you-go with no fixed minimum, and cost is driven by *actual* usage (audio duration and active viewer languages) rather than a flat per-seat price.

**Assumptions:** 60-minute sermon; Gemini traffic (translation + safety verification calls combined, scaling with how many languages are active) runs ~10k–20k input tokens/minute and ~2.5k–5k output tokens/minute (output ≈ a quarter of input).

| Component | Rate | Usage/hour | Cost/hour |
|---|---|---|---|
| Deepgram `nova-3` streaming STT | $0.0077/min | 60 min audio | ~$0.46 |
| Gemini input tokens (translate + verify prompts) | $0.25/1M tokens | 600k–1.2M tokens | ~$0.15–$0.30 |
| Gemini output tokens (translations + verification JSON) | $1.50/1M tokens | 150k–300k tokens | ~$0.23–$0.45 |
| **Total API cost** | | | **~$0.85–$1.20 / hour of live service** |

For a typical church running one ~60-minute translated service a week, that's **roughly $3.50–$5/month in API usage** — the AWS free tier (or a ~$5–10/month VPS after it expires) covers hosting on top of that. There's no seat licensing, no per-viewer surcharge, and no cost incurred outside of active Start/Stop sessions.

*(Pricing verified against Deepgram's and Google's published rates as of mid-2026; actual token usage will vary with sentence count and how many languages are simultaneously active. The system logs every call, so real usage is easy to audit against these estimates once deployed.)*

## Cost vs. commercial competitors

Using the conservative **$1.20/hour** figure from above (holds roughly flat from ~2 up to ~5 simultaneous languages, since one Gemini call covers every active language rather than billing per language), here's how that compares to church-focused live-translation SaaS products, normalized to $/hour:

| Service | Price | Hours included | Languages | Effective $/hour | Extra-language cost |
|---|---|---|---|---|---|
| **Auto Translate Lite** (this project) | ~$3.50–$5/mo API + $0–10/mo hosting | pay-as-you-go, uncapped | 12 configured, only active ones billed | **~$0.85–$1.20** | ~flat (shared call, not per-language) |
| Hope Translator | $20/mo | 5 hrs | 2 | $4.00 | bundled |
| Glossa.live | $99/mo | 25 hrs | 1 | $3.96 | not listed |
| CaptionKit | $20/mo ($12 base + $4/4hrs + $4/2 langs) | 4 hrs | 2 | $5.00 | priced in further $4 blocks |
| Polyglossia | $105/mo | 10 hrs | 1 | $10.50 | +$10/mo per extra language |
| SermonLive | $127/mo | 10 hrs | 1 | $12.70 | +$117/mo per extra language |
| OneAccord | $150/mo | 5 hrs | 1 | $30.00 | not listed |
| Maestra.ai | $165/mo | 5 hrs | 1 | $33.00 | not listed |
| Breeze Translate ("Abundant Sundays") | $15/wk (~$65/mo) | uncapped Sunday services | unlimited (~200) | usage-dependent, not hour-metered | unlimited included |
| Stenomatic.ai | $375/mo | 5 hrs | 130+ | $75.00 | included |
| Wordly AI | ~$540/mo | 5 hrs | dozens, all included | ~$75–$108 | included |

That puts Auto Translate Lite at roughly **3–4× cheaper** than the most aggressively priced competitors (Hope Translator, Glossa.live, CaptionKit), and **60–90× cheaper** than premium/enterprise players (Stenomatic, Wordly) at comparable hour volumes.

**Caveats, to keep this honest:**
- This isn't apples-to-apples. Every row above is a fully managed product — hosting, uptime, support, ProPresenter/OBS integrations, and a polished volunteer-facing UI are all included in that price. Auto Translate Lite is self-hosted software: someone has to deploy it, keep the VPS patched, and be the fallback if something breaks. The dollar gap is real, but part of it is buying out of that operational overhead, not just API margin.
- Several competitors (Polyglossia, SermonLive, CaptionKit) charge per additional simultaneous language on top of their base plan — Auto Translate Lite's architecture doesn't have that cost shape at all, which is arguably the sharper differentiator for a multilingual congregation than the raw $/hour number.
- Pricing was pulled from public marketing pages and a third-party aggregator ([hopetranslator.com's comparison page](https://www.hopetranslator.com/en/resources/live-translation-pricing-comparison)) in July 2026; vendors change plans/tiers often and may offer unlisted nonprofit or church discounts — re-verify directly before using these numbers in front of a decision-maker.

## Local development

Two apps run side by side:

```bash
cd server && npm install && cp .env.example .env   # fill in DEEPGRAM_API_KEY and GEMINI_API_KEY
npm run dev   # http://localhost:3001
```

```bash
cd web && npm install && cp .env.example .env.local
npm run dev   # http://localhost:3000
```

Open `http://localhost:3000/capture` to start a session, and `http://localhost:3000` to pick a language and view live captions.

## Tests

```bash
cd server && npm test
```
