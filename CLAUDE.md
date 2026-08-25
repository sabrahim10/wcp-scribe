# Scribe — West County Physicians

AI-powered medical scribe web app. Static site hosted on GitHub Pages. Records patient sessions to disk, transcribes them with AssemblyAI after the session ends, and generates structured SOAP notes via the Anthropic API.

## Project Structure

```
wcp-scribe/
├── index.html          # App markup — UI structure
├── helpers.js          # Pure, DOM-free logic (loaded before app.js; shared with tests)
├── app.js              # Recording, audio store, transcription, SOAP API call, UI wiring
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

**Architecture note:** pure logic (audio-format negotiation, speaker-labeled
transcript assembly, CPT, SOAP parsing, error mapping, retention policy, spend
estimation, diagnostics formatting) lives in `helpers.js` with no DOM/browser
access, so the *identical* code is tested in Node and in a real browser. `app.js`
holds the DOM wiring and side-effecting code and depends on those globals.

## What This App Does

1. Physician opens the URL on their laptop (Safari, Chrome, or Edge)
2. On first use, pastes two API keys — AssemblyAI and Anthropic (both in localStorage)
3. Hits the record button — audio is captured and written to IndexedDB in 5s chunks
4. Hits stop when the session ends
5. The audio uploads to AssemblyAI automatically; a speaker-labeled transcript returns
6. Clicks "Generate SOAP Note" — transcript is sent to Claude API
7. Structured S/O/A/P note appears, ready to copy into EHR

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS — no build step, no framework, no dependencies
- **Capture:** `MediaRecorder` → IndexedDB (`scribe_audio` database, `chunks` store)
- **Speech:** AssemblyAI `universal-3-5-pro`, `domain: medical-v1`, speaker diarization
- **AI:** Anthropic Claude API (`claude-opus-5`) via direct browser fetch
- **Hosting:** GitHub Pages (static, free)
- **Auth:** None — security through private repo + obscure URL + localStorage key storage

## Why There Is No Backend

Both APIs are reachable from the browser directly: AssemblyAI returns
`access-control-allow-origin: *` with `Authorization` permitted on `/v2/upload`
and `/v2/transcript`, and Anthropic allows it via the
`anthropic-dangerous-direct-browser-access` header. That is what keeps this a
static site with no build step. If a proxy is ever added, it should be for **key
custody**, not for CORS.

## API Key Handling

Two keys, both entered on first load and stored in `localStorage`:

| Key | Storage key | Sent to |
|---|---|---|
| AssemblyAI (transcription) | `scribe_assembly_key` | `api.assemblyai.com` |
| Anthropic (SOAP note) | `scribe_key` | `api.anthropic.com` |

Both persist until browser storage is cleared, and can be re-entered at any time
via the **Keys** button in the header.

**This is acceptable for personal/internal use on a private laptop.** For a
production multi-user deployment, replace with a serverless proxy so neither key
touches the client.

## Claude API Call

- **Model:** `claude-opus-5`
- **Max tokens:** 8000
- **Input:** Speaker-labeled transcript (`Speaker A:` / `Speaker B:` lines)
- **Output:** JSON object with keys `S`, `O`, `A`, `P`
- **Prompt role:** Psychiatric scribe. Told to infer which anonymous speaker is the
  clinician vs. the patient and attribute accordingly, and to write a garbled
  medication name as heard rather than guessing a plausible substitute.

## Key Constraints

- Must work as a **static site** — no build process, no npm at runtime, no bundler
- Must work in **Safari on macOS** (the physician's actual browser), and Chrome/Edge
- No backend — everything runs in the browser
- No patient names should be used in sessions (HIPAA best practice)
- Keep the GitHub repo **private**
- **Audio is never deleted while it is the only copy of a session** (see Tier 2)

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

## Tier 1c — Sessions persist automatically (done — July 2026)

Field incident (June 23, 2026): note generation errored after a session; the
transcript only lived in the single `scribe_draft` slot, which a later recording
overwrote — the transcript was permanently lost, because history was only written
when "New Session" was clicked. The save lifecycle is now:

- [x] **Persist on stop, not on New Session** — `persistSession()` upserts the
  session into `scribe_sessions` (via `upsertSession` in `helpers.js`, capped at
  100) the moment recording stops, again after a successful note generation, on
  draft restore, and at New Session (to capture hand-edits to the SOAP fields).
  "New Session" is now just a screen reset — nothing is lost by skipping it.
- [x] **Sessions dated by recording start** (`sessionStartISO`), not by when they
  were saved — entries land under the day the patient was actually seen.
- [x] **Draft slot demoted to mid-recording crash protection only** — it is
  cleared once the transcript is in history, and `saveDraft` skips writing when
  the transcript is already persisted (no stale restore banners / duplicates).
  A restored draft is committed to history immediately, and starting a new
  recording while a crash draft is pending banks it to history
  (`bankPendingDraft`) instead of overwriting it. Only an explicit "Discard"
  deletes a draft.
- [x] **Generate a note later from history** — sessions without a note show a
  "No note yet" flag in the sidebar; opening one shows the Generate button, which
  generates from the stored transcript and attaches the note to that session.
- [x] **Reassuring generate-error message** — the error banner now says the
  transcript is already saved and can be retried now or later.
- [x] **Fixed silent discard** — clicking "New Session" while viewing a past
  session used to skip saving and wipe the unsaved live transcript.

## Tier 2 — Real transcription, and the end of missed notes (done — August 2026)

Tiers 1/1b/1c all protected the transcript *after* speech recognition produced it.
But the Web Speech API was a live, one-shot, unrecoverable pipeline: **no audio was
ever stored**, so anything recognition failed to hear was gone with no retry path —
the ~5s no-speech kill, the restart gap, the backgrounded-tab mic suspend. Tier 2
removes the entire class of problem by recording the audio first.

**The invariant:** audio reaches IndexedDB *before* anything else is attempted, so
every downstream failure (no credits, no network, bad key, closed tab, AssemblyAI
outage) delays a note instead of losing one.

- [x] **`MediaRecorder` → IndexedDB, every 5 seconds.** `scribe_audio` DB, `chunks`
  store, keyed `[sessionId, seq]` with a `bySession` index — each flush is a small
  write, not a rewrite of the growing recording. localStorage cannot hold audio.
- [x] **Web Speech API deleted entirely.** With it went the beeps, the restart churn,
  the fan load, the duplicate-final dedupe, the zombie watchdog, and Apple's servers.
  `buildTranscript`, `friendlyRecognitionError`, `isTransientRecognitionError`, and
  `serializeDraft` are gone from `helpers.js`.
- [x] **Backgrounding no longer breaks anything.** `MediaRecorder` is not suspended
  the way `SpeechRecognition` was, so she can switch apps or Spaces mid-session. This
  was previously documented as OS-level and unfixable; it is fixed by not using
  speech recognition.
- [x] **Honest level meter.** The 12 bars are driven by an `AnalyserNode` on the
  *same* MediaStream being written to disk, so movement is real proof of capture.
  Compositor-only (`transform: scaleY`), gated to ~12fps, and skipped entirely under
  `prefers-reduced-motion` — cheaper than the Tier 1 CSS waveform it replaced, and
  unlike that waveform it cannot animate while the mic is dead.
- [x] **Speaker diarization** (`speaker_labels: true`) → the transcript is built as
  `Speaker A:` / `Speaker B:` turns by `buildUtteranceTranscript`, with consecutive
  turns merged. Claude is told to infer which is the clinician.
- [x] **Medical Mode** (`domain: 'medical-v1'`) — normalizes dosages into clinical
  notation ("sertraline fifty milligrams" → `sertraline 50 mg`) and cuts missed
  clinical entities. Costs $0.15/hr on top of the $0.21/hr base.
- [x] **Resumable transcription.** Session state (`transcriptionStatus`, `assemblyId`)
  is written to history at every step. On load, `resumeUnfinishedWork()` re-polls
  jobs already submitted (the result is waiting server-side and already paid for) and
  offers a banner for sessions whose audio never got uploaded.
- [x] **Every failure is retryable.** Sidebar flags the session `Needs transcript`;
  opening it offers **Transcribe from saved audio**. `assemblyErrorMessage()` maps
  each failure to a specific action, and every message ends by saying the audio is safe.
- [x] **Spend estimate.** Cumulative `audio_duration` is tallied in `scribe_usage`;
  the header meter reports estimated credit left and warns below $5, so credits
  running out is visible in advance rather than as a mid-week failure.

### Audio retention rule (`selectAudioToPrune`) — read before changing

Recordings are large, so they cannot accumulate forever. Audio is dropped **only**
when the session both (a) already has a finished note and (b) has fallen outside the
10 most recent entries. A session still owing a transcript or a note keeps its audio
no matter how old it is, because that audio is the only copy. There is a test named
"NEVER drops audio for a session without a note" guarding exactly this — if it goes
red, the safety property is broken.

## Potential Improvements (Future)

- [ ] Serverless proxy to move both API keys server-side
- [ ] BAA with AssemblyAI + Anthropic if this ever goes beyond personal use.
  **Deliberately skipped for now** (owner's decision, Aug 2026). Note that Tier 2
  *reduced* exposure: Apple's servers are no longer in the path at all, leaving
  AssemblyAI and Anthropic as the only third parties.
- [x] Patient session history (localStorage)
- [ ] Export to PDF
- [ ] Specialty-specific SOAP templates (psychiatry vs general)
- [x] Speaker diarization (separate physician vs patient speech)
- [x] Audio survives accidental tab close / crash / timeout
- [ ] `hasSafetyDoc` misses the phrasing "harming yourself" / "hurt yourself", so a
  session where SI *was* screened can still raise the "SI/HI not documented" warning.
  Adding those terms to `SAFETY_TERMS` would cut false alarms — left alone for now
  because it is a clinical-safety heuristic and should be a deliberate change.

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
npm test                     # Node runner (node --test) — 32 cases
python3 -m http.server 8000  # then open http://localhost:8000/tests/harness.html in SAFARI
```

The harness must be served over HTTP for Safari — opened via file:// Safari blocks
the `../helpers.js` load (parent-directory access) and every helper comes up
undefined; Chrome tolerates it, which can mask the problem. The harness shows an
explanatory banner instead of a screen of bogus failures when this happens.

Coverage (63 cases): audio-format negotiation (`pickAudioMime`, with Chrome- and
Safari-shaped detectors), mic error mapping, speaker-labeled transcript assembly
(`buildUtteranceTranscript`), transcription error mapping, session-state predicates,
**the audio retention rule** (`selectAudioToPrune`), spend estimation, key-shape
checks, CPT selection, SI/HI detection, SOAP JSON parsing (fences/prose/truncation
repair), session history upsert, and diagnostics formatting.

The harness additionally has three interactive checks that only mean anything in a
real browser, and are the reason to run it in Safari specifically:

1. **Check capabilities** — what this browser supports, and which container
   `pickAudioMime` negotiates against the real `MediaRecorder` (Safari: MP4/AAC;
   Chrome: WebM/Opus).
2. **Run round-trip** — writes chunks to IndexedDB out of order, reads them back,
   and proves the audio reassembles byte-identical and correctly ordered. **This is
   the crash-safety property.** If it fails, a recording would not survive a closed
   tab. (Safari Private Browsing blocks IndexedDB — that will show up here.)
3. **Run simulation** — a realistic AssemblyAI payload through the real assembly path.

For anything involving the mic, a real upload, or the fan, run
`tests/SAFARI_CHECKLIST.md` on the actual MacBook — automated tests can't cover those.
Its §6 (failure-path test) is the one that verifies the core Tier 2 promise: a bad
key or dead network delays a note rather than losing one.

Run `npm test` (green) **and** at least the harness in Safari before pushing. The app
stays a dependency-free static site; `package.json` exists only for the test command.

## Common Issues

**No sound reaching the mic:** The level meter stays flat and, after 20 seconds, a
banner points at System Settings ▸ Sound ▸ Input. Almost always the wrong input
device. The recording keeps running regardless.

**Transcription failed:** Read the message — it names the cause (credits, key, rate
limit, server, offline) and the fix. **The audio is always still on disk**; open the
session from the sidebar and click *Transcribe from saved audio*. Nothing is lost.

**Credits ran out:** AssemblyAI pauses API access at $0 rather than auto-charging.
Top up at assemblyai.com/app, then retry the affected sessions from the sidebar. The
header meter warns below $5 so this should never be a surprise.

**Anthropic API key error:** Key must start with `sk-ant-`. On a 401 the key may be
invalid or expired — re-enter via the **Keys** button.

**SOAP note parsing error:** Claude returned malformed JSON. Retry — rare, and
`repairTruncatedJSON` salvages most truncations. The transcript is already saved.

**Nothing survived a crash:** Check that Safari is not in Private Browsing, which
blocks IndexedDB. The harness round-trip test (§1 of the checklist) detects this.

**Storage full:** IndexedDB writes fail and a warning appears mid-recording. Old
audio is pruned automatically (see the retention rule), but a very full disk can
still bite. Audio runs ~64 kbps, so roughly 21 MB per hour of session.
