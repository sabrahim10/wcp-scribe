# Scribe — West County Physicians

AI-powered medical scribe web app. Single HTML file hosted on GitHub Pages. Records patient sessions via browser speech recognition, transcribes in real time, and generates structured SOAP notes via the Anthropic API.

## Project Structure

```
wcp-scribe/
├── index.html          # App markup — UI structure
├── helpers.js          # Pure, DOM-free logic (loaded before app.js; shared with tests)
├── app.js              # Recording, auto-save, diagnostics, SOAP API call, UI wiring
├── styles.css          # All styling + animations
├── package.json        # Dev-only: `npm test` (the app itself has no build step)
├── tests/
│   ├── spec.js             # Shared test cases (run by both Node and the browser)
│   ├── scribe.test.js      # Node runner (node --test)
│   ├── harness.html        # In-browser runner — open in Safari/Chrome to verify there
│   └── SAFARI_CHECKLIST.md # Manual on-device QA steps (mic/fan/timeout/recovery)
├── CLAUDE.md           # This file
└── README.md           # Optional
```

**Architecture note:** pure logic (transcript assembly, CPT, SOAP parsing, draft
serialization, error mapping, diagnostics formatting) lives in `helpers.js` with no
DOM/browser access, so the *identical* code is tested in Node and in a real browser.
`app.js` holds the DOM wiring and side-effecting code and depends on those globals.

## What This App Does

1. Physician opens the URL on their work laptop in Chrome
2. On first use, pastes Anthropic API key (stored in localStorage, persists across sessions)
3. Hits the record button — browser Web Speech API transcribes speech in real time
4. Hits stop when session ends
5. Clicks "Generate SOAP Note" — transcript is sent to Claude API
6. Structured S/O/A/P note appears, ready to copy into EHR

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS — no build step, no framework, no dependencies
- **Speech:** Web Speech API (built into Chrome/Edge — no external service)
- **AI:** Anthropic Claude API (`claude-sonnet-4-6`) via direct browser fetch
- **Hosting:** GitHub Pages (static, free)
- **Auth:** None — security through private repo + obscure URL + localStorage key storage

## API Key Handling

The Anthropic API key is entered by the user on first load and stored in `localStorage` under the key `scribe_key`. It persists until the user clears browser storage. It is sent directly from the browser to `api.anthropic.com` over HTTPS.

**This is acceptable for personal/internal use on a private work laptop.** For a production multi-user deployment, replace with a Vercel serverless proxy so the key never touches the client.

## Claude API Call

- **Model:** `claude-sonnet-4-6`
- **Max tokens:** 4000 (raised from 1500 so long intake notes don't truncate mid-JSON)
- **Input:** Raw transcript text
- **Output:** JSON object with keys `S`, `O`, `A`, `P`
- **Prompt role:** Psychiatric scribe — uses proper psychiatric terminology, only uses information present in the transcript

## Key Constraints

- Must work as a **single HTML file** — no build process, no npm, no bundler
- Must work in **Chrome on desktop** (Web Speech API requirement)
- No backend — everything runs in the browser
- No patient names should be used in sessions (HIPAA best practice)
- Keep the GitHub repo **private**

## Tier 1 Reliability & Performance (done — June 2026)

Fixes for two field-reported issues on long (1-hour new-intake) sessions in Safari
on an older MacBook: (1) browser timeouts/errors that lost the transcript, and
(2) fan noise ("airplane engine") after 10–15 min of recording.

- [x] **Pure-CSS waveform** — replaced the 100ms `setInterval` that mutated 12 bar
  heights (each with a CSS `transition`, forcing continuous layout+paint) with a
  compositor-only `transform: scaleY` animation. This was the main CPU/fan cause.
- [x] **Throttled transcript rendering** — the DOM now repaints at most once per
  400ms instead of on every interim recognition result (`scheduleTranscriptRender`).
- [x] **`prefers-reduced-motion`** support — disables the pulse rings, waveform,
  blinking cursor, and status-dot pulse, cutting idle GPU work.
- [x] **Hardened recognition restart** — `recognition.start()` is wrapped in
  try/catch with retry (`safeStartRecognition`); `onend` restarts with a delay;
  `no-speech`/`aborted`/`network` errors are no longer surfaced as failures.
- [x] **Silent-death watchdog** — if no result arrives for 12s while recording,
  recognition is kicked so an hour-long session keeps transcribing (Safari ends
  the underlying session roughly every minute).
- [x] **Auto-save + crash recovery** — the transcript is persisted to
  `localStorage` (`scribe_draft`) every 10s and on `beforeunload`/`pagehide`/tab
  hide. On next load an unsaved transcript is offered for restore via a banner
  (`restoreDraft`/`discardDraft`). The draft is cleared once the session is saved
  to history. A timeout can no longer lose an intake.
- [x] **`max_tokens` 1500 → 4000 + JSON repair** — long notes no longer truncate
  mid-JSON; `parseSOAPResponse`/`repairTruncatedJSON` also salvage a cut-off note.

## Tier 1b — Safari hardening, diagnostics & real-browser tests (done — June 2026)

Follow-up after researching Safari's Web Speech API (audio goes to Apple servers;
depends on system Dictation/Siri; `onend` is unreliable; it re-emits/duplicates
final results). See `tests/SAFARI_CHECKLIST.md`.

- [x] **Safari double-text fix** — `buildTranscript` (in `helpers.js`) rebuilds the
  transcript from the results list each event and drops re-emitted duplicate finals,
  instead of blindly appending. `sessionBase` carries finalized text across restarts.
- [x] **Human-readable errors** — `friendlyRecognitionError` maps cryptic codes to
  guidance (e.g. `service-not-available`/`not-allowed` → "turn on macOS Dictation").
  `isTransientRecognitionError` decides what's surfaced vs. handled silently.
- [x] **PHI-free diagnostics** — a rolling event log (`scribe_diag` in localStorage,
  metadata only — event names, error codes, restart counts, durations; **never
  transcript text**) via `diag()`. A subtle "Copy diagnostics" link appears only
  while an error is shown (`copyDiagnostics` → `formatDiagnostics`).
- [x] **Shared Node + browser tests** — pure logic extracted to `helpers.js`; test
  cases in `tests/spec.js` run under `node --test` AND in `tests/harness.html`
  (open in Safari to confirm behavior there, incl. a fake duplicate-and-restart
  stream). 27 cases, all passing.
- [x] **Manual Safari QA checklist** — `tests/SAFARI_CHECKLIST.md` covers system
  settings, fan/heat, 60-min endurance, crash/restore, and diagnostics.

## Recognition lifecycle & reconnect behavior (how it actually runs)

Field testing on Safari established these behaviors — read this before touching the
recording loop in `app.js`:

- **Restart is driven by recognition *liveness*, not silence.** `makeRecognition()`
  wires `onstart`/`onresult`/`onend`; `recogRunning`/`starting` track whether a
  session is live. `onend` restarts via `scheduleRestart()`; `tryStartRecognition()`
  starts with try/catch, and on a thrown/blocked start it backs off exponentially
  (`RESTART_MIN_MS`→`RESTART_MAX_MS`) and recreates the recognizer. It never
  silently gives up while `isRecording` is true.
- **Do NOT stop() on silence.** An earlier watchdog force-stopped every ~12s of
  silence; that triggered Safari's rapid-restart abuse block (`not-allowed`) and was
  the cause of mid-session death. The watchdog now only acts when capture is truly
  down (`!recogRunning`) or a session is a "zombie" (running but silent > `ZOMBIE_MS`).
- **Safari's ~5s no-speech timeout is unavoidable.** During pure silence Safari ends
  the session (~5s) and macOS plays a beep — we cannot lengthen that window. We only
  space out restarts during silence (`RESTART_SILENCE_MS`, ~2.5s) vs. fast restarts
  mid-conversation (`RESTART_MIN_MS`) so it doesn't churn/beep constantly. Tune
  `RESTART_SILENCE_MS` up to reduce beeps (trade-off: may clip the first word after
  a long silence).
- **Honest status via `setCapturing()`** — before any speech, quiet cycling shows a
  calm "Listening…" (red dot); a *lost* established stream shows amber "Reconnecting…"
  (`status-dot.reconnecting`). The timer/waveform run on their own and must never be
  read as proof that capture is alive.
- **Backgrounding suspends the mic (OS-level, unfixable).** When the Safari tab is
  hidden (e.g. swiping to a full-screen app on another Space) macOS suspends the mic
  and recognition drops after ~5s. The `visibilitychange` handler resumes capture
  immediately on return. Foreground use (the physician's normal case) stays live
  indefinitely. Tier 2 (below) is the only way around the backgrounded case.
- **Error banners** — only shown for a *persistent* failure (`!hasResult &&
  restartCount >= 2`), and auto-cleared the moment a result arrives, so a transient
  Safari `not-allowed` at startup no longer leaves a stale "blocked" banner.

## Potential Improvements (Future)

- [ ] Vercel proxy to move API key server-side
- [ ] Anthropic BAA for HIPAA compliance
- [ ] **HIPAA note (Safari):** Safari's Web Speech API sends session audio to
  **Apple's servers** for transcription — a PHI disclosure not covered by an
  Anthropic BAA. Chrome/Edge behave similarly. A self-hosted/on-device STT (Tier 2)
  would remove this. Worth reviewing before any non-personal/production use.
- [x] Patient session history (localStorage)
- [ ] Export to PDF
- [ ] Specialty-specific SOAP templates (psychiatry vs general)
- [ ] Speaker diarization (separate physician vs patient speech)
- [x] Auto-save transcript in case of accidental tab close / timeout
- [ ] **Tier 2 (if Safari still flaky):** capture audio via `MediaRecorder` and
  stream to a real STT service (Whisper/Deepgram) instead of the Web Speech API —
  browser-agnostic and robust for hour-long sessions, but adds cost + a BAA need.

## SOAP Note Prompt

The system prompt instructs Claude to act as a psychiatric medical scribe. It:
- Returns only a JSON object (no markdown, no preamble)
- Maps transcript content to S/O/A/P sections
- Notes "Not documented in this session" for objective fields not mentioned
- Uses proper psychiatric terminology
- Does not hallucinate information not present in the transcript

## Testing

Dev-only, zero-dependency. Test cases live in `tests/spec.js` and run in two places:

```
cd wcp-scribe
npm test                     # Node runner (node --test) — 27 cases
open tests/harness.html      # Same cases in a real browser — run this in SAFARI
```

Coverage: transcript assembly + Safari duplicate-final dedupe (`buildTranscript`),
CPT selection, SI/HI detection, SOAP JSON parsing (fences/prose/truncation repair),
draft serialization/recovery, and error-code → message mapping.

For anything involving the mic, Apple's speech servers, or the fan, run
`tests/SAFARI_CHECKLIST.md` on the actual MacBook — automated tests can't cover those.

Run `npm test` (green) **and** at least the harness in Safari before pushing. The app
stays a dependency-free static site; `package.json` exists only for the test command.

## Common Issues

**Speech recognition not working:** Best in Chrome or Edge. Safari's Web Speech API
works but is less reliable on long sessions — the app now hardens against this with
a restart watchdog and auto-save (see Tier 1 above). Microphone permission must be granted.

**API key error:** Key must start with `sk-ant-`. If getting 401, the key may be invalid or expired. Clear localStorage and re-enter.

**SOAP note parsing error:** Claude returned malformed JSON. Retry — this is rare but can happen. If persistent, check the raw transcript for unusual characters.

**Recognition stops mid-session:** Web Speech API has a timeout on silence. If the patient pauses for more than ~60 seconds, recognition may stop. The stop/start button resets it.
