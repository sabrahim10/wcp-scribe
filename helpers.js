// ── Pure helpers (no DOM, no browser globals) ──────────────────────────────────
//
// Everything here is deterministic and side-effect-free so it can be tested
// identically in Node (`node --test`) and in a real browser (tests/harness.html).
// app.js loads this via <script> before itself, so these become window globals.
// In Node they are exported via module.exports at the bottom.

// SI/HI safety-documentation detection ------------------------------------------

const SAFETY_TERMS = [
  'suicid', 'self-harm', 'self harm', 'homicid', 'ideation',
  'hurt himself', 'hurt herself', 'hurt themselves',
  'kill himself', 'kill herself',
  'harm to self', 'harm to others',
  ' si ', ' hi ', 'si/hi', 'no si', 'denies si'
];

function hasSafetyDoc(text) {
  const lower = (text || '').toLowerCase();
  return SAFETY_TERMS.some(t => lower.includes(t));
}

// CPT code selection by session length ------------------------------------------

function selectCPT(seconds) {
  if (!seconds) return [];
  const min = Math.floor(seconds / 60);
  if (min < 16) return [['99212', 'Brief E&M']];
  if (min < 38) return [['90832', '30 min therapy'], ['99213', 'Med management']];
  if (min < 53) return [['90834', '45 min therapy'], ['99214', 'Med management']];
  return [['90837', '60 min therapy'], ['99215', 'Med management']];
}

// Audio capture -----------------------------------------------------------------
//
// MediaRecorder container support is browser-specific and there is no single
// format both engines take: Chrome/Edge produce WebM/Opus, Safari produces
// MP4/AAC and returns false for every WebM type. Opus is preferred where it
// exists (roughly half the bytes for speech), so the list is ordered by
// preference and the first supported entry wins. An empty string means "let the
// browser pick its own default", which is still a valid MediaRecorder config.
const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

function pickAudioMime(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return '';
  for (const mime of AUDIO_MIME_CANDIDATES) {
    let ok = false;
    try { ok = !!isTypeSupported(mime); } catch (e) { ok = false; }
    if (ok) return mime;
  }
  return '';
}

// Human-readable messages for getUserMedia failures ------------------------------
//
// Replaces the old SpeechRecognition error mapping — the failures that matter
// now are microphone-permission and device problems, not speech-service ones.
function micErrorMessage(name) {
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Microphone access was blocked. Allow the microphone for this site (Safari ▸ Settings for This Website ▸ Microphone), then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. Check that the mic is connected and selected in System Settings ▸ Sound ▸ Input.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is being used by another app. Quit anything else using it (Zoom, FaceTime, Teams), then try again.';
    case 'OverconstrainedError':
      return 'The selected microphone could not be used. Pick a different input in System Settings ▸ Sound ▸ Input, then try again.';
    default:
      return 'Could not start the microphone: ' + (name || 'unknown error');
  }
}

// Transcription — speaker-labeled transcript assembly ----------------------------
//
// AssemblyAI returns both a flat `text` and a list of diarized `utterances`
// ({ speaker: 'A', text: '...' }). The labeled form is what gets sent to Claude:
// knowing who said what is what lets the note separate the patient's report from
// the clinician's observations instead of guessing. Consecutive turns by the same
// speaker are merged so one person's paragraph stays one paragraph. Falls back to
// the flat text whenever diarization returned nothing usable.
function buildUtteranceTranscript(utterances, fallbackText) {
  const list = Array.isArray(utterances) ? utterances : [];
  const lines = [];
  let prevSpeaker = null;
  for (const u of list) {
    const text = String((u && u.text) || '').trim();
    if (!text) continue;
    const speaker = (u && u.speaker != null) ? String(u.speaker) : '?';
    if (speaker === prevSpeaker && lines.length) {
      lines[lines.length - 1] += ' ' + text;
    } else {
      lines.push('Speaker ' + speaker + ': ' + text);
      prevSpeaker = speaker;
    }
  }
  return lines.length ? lines.join('\n') : String(fallbackText || '').trim();
}

// Word count for the transcript header. Speaker labels ("Speaker A:") are part
// of the text but are not words anyone said, so they are dropped first —
// otherwise an hour of quick back-and-forth reads as hundreds of words longer
// than it is.
function countWords(text) {
  const body = String(text || '').replace(/^\s*Speaker\s+\w+:\s*/gm, ' ');
  const words = body.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

// Transcription — error mapping --------------------------------------------------
//
// Every message ends by saying the audio is safe, because it always is: the
// recording is written to IndexedDB before any upload is attempted, so a failure
// here delays a note, it never loses one.
function assemblyErrorMessage(status, bodyText) {
  const lower = String(bodyText || '').toLowerCase();
  const code = Number(status) || 0;
  const saved = ' The audio is saved — you can retry this session from the sidebar at any time.';

  if (code === 402 || lower.includes('insufficient') || lower.includes('balance') ||
      lower.includes('credit') || lower.includes('payment')) {
    return 'AssemblyAI credits are used up. Top up at assemblyai.com/app, then retry.' + saved;
  }
  if (code === 401 || code === 403 || lower.includes('unauthorized') || lower.includes('invalid api key')) {
    return 'AssemblyAI rejected the API key. Re-enter it in Settings, then retry.' + saved;
  }
  if (code === 429 || lower.includes('rate limit')) {
    return 'AssemblyAI is rate-limiting this account. Wait a moment, then retry.' + saved;
  }
  if (code >= 500) {
    return 'AssemblyAI had a server error (' + code + '). Retry in a minute.' + saved;
  }
  if (code === 400) {
    return 'AssemblyAI rejected the audio (400). This usually means the recording is empty or corrupt.' + saved;
  }
  if (code === 0) {
    return 'Could not reach AssemblyAI — check the internet connection, then retry.' + saved;
  }
  return 'Transcription failed (' + code + ').' + saved;
}

// Note generation — error mapping ------------------------------------------------
//
// The counterpart to assemblyErrorMessage, for the Anthropic call. By the time
// this can fire the transcript is already in `scribe_sessions` (transcribeSession
// writes it there before it is ever drawn on screen), so every message names the
// cause, the fix, and — first, because that is the question the physician is
// actually asking — the fact that nothing has been lost.
function noteErrorMessage(status, bodyText) {
  const lower = String(bodyText || '').toLowerCase();
  const code = Number(status) || 0;
  const saved = 'The transcript is saved. Open this session from the sidebar and generate the note again whenever you like — ';

  if (lower.includes('credit balance') || lower.includes('insufficient') || code === 402) {
    return saved + 'the Anthropic account is out of credit. Top up at console.anthropic.com, then generate again.';
  }
  if (code === 401 || code === 403 || lower.includes('authentication') || lower.includes('invalid x-api-key')) {
    return saved + 'Anthropic rejected the API key. Re-enter it with the Keys button, then generate again.';
  }
  // Narrow on purpose: "model" appears in plenty of unrelated 400s, and telling
  // her to check account access when the real fault is elsewhere sends her to the
  // wrong place.
  if (code === 404 || lower.includes('not_found') || lower.includes('model:')) {
    return saved + 'this Anthropic account cannot reach the model the app asks for. Check the key belongs to an account with Claude API access.';
  }
  if (code === 429 || lower.includes('rate limit')) {
    return saved + 'Anthropic is rate-limiting this account. Wait a minute, then generate again.';
  }
  if (code === 529 || lower.includes('overloaded')) {
    return saved + 'Anthropic is overloaded right now. Try again in a minute.';
  }
  if (code >= 500) {
    return saved + 'Anthropic had a server error (' + code + '). Try again in a minute.';
  }
  if (code === 0) {
    return saved + 'the request never reached Anthropic — check the internet connection, then generate again.';
  }
  return saved + 'the note request failed (' + code + ').';
}

// Transcription — status vocabulary ----------------------------------------------
//
// One vocabulary shared by the live status line and the sidebar flags, so a
// session in flight reads the same in both places.
function transcriptionLabel(status) {
  switch (status) {
    // A session is banked to history the moment recording starts, so this state
    // is what a still-running (or abandoned) recording reads as in the sidebar.
    case 'recording':  return 'Recording…';
    case 'uploading':  return 'Uploading audio…';
    case 'queued':     return 'Queued at AssemblyAI…';
    case 'processing': return 'Transcribing…';
    case 'completed':  return 'Transcribed';
    case 'error':      return 'Transcription failed';
    default:           return '';
  }
}

// Whether a saved session still owes a transcript — it has audio on disk but no
// text yet (transcription failed, was interrupted, or never ran).
function needsTranscription(session) {
  if (!session) return false;
  if (String(session.transcript || '').trim()) return false;
  return !!session.hasAudio;
}

// Whether a saved session has an actual note (older entries may carry an
// all-empty soap object from before notes were saved with their session).
function sessionHasNote(session) {
  const soap = session && session.soap;
  return !!soap && ['S', 'O', 'A', 'P'].some(k => {
    const t = String(soap[k] || '').trim();
    return t && t !== '—';
  });
}

// Interrupted recordings ---------------------------------------------------------
//
// A session is written to history the moment recording starts, carrying
// `transcriptionStatus: 'recording'`. A clean stop moves it to 'queued'. So a
// session still sitting in 'recording' on a later page load means the recorder
// died without stopping — a crashed or discarded tab.
//
// This matters more than it sounds: on Aug 31, 2026 a tab was reloaded 21
// minutes into a one-hour intake and nothing said so. The screen came back
// blank, the physician was with a patient, and the remaining ~40 minutes were
// never captured by anything. Detecting this is what turns a 40-minute loss into
// a 30-second one.
function isInterruptedRecording(session) {
  return !!session && session.transcriptionStatus === 'recording';
}

function findInterruptedSessions(sessions) {
  return (sessions || []).filter(isInterruptedRecording);
}

// Session grouping -----------------------------------------------------------------
//
// The sidebar is a flat list, which stops working once there are more than a
// couple of weeks of visits in it. Sessions arrive newest-first, so grouping in
// encounter order keeps the days in that order too.
function dayKey(dateISO) {
  const d = new Date(dateISO);
  if (isNaN(d.getTime())) return 'undated';
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

function groupSessionsByDay(sessions) {
  const groups = [];
  const byKey = new Map();
  (sessions || []).forEach(s => {
    const key = dayKey(s && s.date);
    if (!byKey.has(key)) {
      const g = { key, date: s && s.date, sessions: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    byKey.get(key).sessions.push(s);
  });
  return groups;
}

// "Today" / "Yesterday" / "Aug 28" / "Dec 3, 2025". `now` is injectable so this
// is testable without freezing the clock.
function dayLabel(dateISO, now) {
  const d = new Date(dateISO);
  if (isNaN(d.getTime())) return 'Undated';
  const ref = now ? new Date(now) : new Date();
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(ref) - midnight(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const base = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.getFullYear() === ref.getFullYear() ? base : base + ', ' + d.getFullYear();
}

// Audio retention ----------------------------------------------------------------
//
// Recordings are large, so they cannot accumulate forever — but the rule is
// deliberately conservative: audio is only ever dropped for a session that
// already has a finished note AND has fallen outside the most recent
// `keepRecent` entries. A session still waiting on a transcript or a note keeps
// its audio no matter how old it is, because that audio is the only copy.
// `sessions` is newest-first (see upsertSession). Returns ids safe to delete.
function selectAudioToPrune(sessions, keepRecent) {
  const keep = keepRecent == null ? 10 : keepRecent;
  const out = [];
  (sessions || []).forEach((s, i) => {
    if (i < keep) return;
    if (!s || !s.hasAudio) return;
    if (!sessionHasNote(s)) return;
    out.push(s.id);
  });
  return out;
}

// Spend estimation ---------------------------------------------------------------
//
// AssemblyAI bills per second of audio. Tracking cumulative seconds locally gives
// a running estimate of the free-credit balance, so it can warn ahead of time
// instead of transcription simply starting to fail mid-week.
const ASSEMBLY_RATE_PER_HOUR = 0.36;   // Universal-3.5 Pro ($0.21) + Medical Mode ($0.15)
const ASSEMBLY_FREE_GRANT    = 50.00;  // signup credit

function estimateCost(seconds, ratePerHour) {
  const rate = ratePerHour == null ? ASSEMBLY_RATE_PER_HOUR : ratePerHour;
  const secs = Math.max(0, Number(seconds) || 0);
  return (secs / 3600) * rate;
}

function creditStatus(spentUsd, grantUsd) {
  const grant = grantUsd == null ? ASSEMBLY_FREE_GRANT : grantUsd;
  const spent = Math.max(0, Number(spentUsd) || 0);
  const remaining = Math.max(0, grant - spent);
  let level = 'ok';
  if (remaining <= 0) level = 'empty';
  else if (remaining <= 5) level = 'low';
  return { spent, remaining, level };
}

function formatUsd(n) {
  const v = Math.max(0, Number(n) || 0);
  return '$' + v.toFixed(2);
}

// Estimated hours of recording still affordable at the current rate.
function hoursRemaining(remainingUsd, ratePerHour) {
  const rate = ratePerHour == null ? ASSEMBLY_RATE_PER_HOUR : ratePerHour;
  if (!rate) return 0;
  return Math.max(0, (Number(remainingUsd) || 0) / rate);
}

// API key shape checks -----------------------------------------------------------

function isLikelyAnthropicKey(key) {
  return /^sk-ant-/.test(String(key || '').trim());
}

// AssemblyAI keys are a 32-char hex string today, but the check stays loose so a
// future format change cannot lock the app out of a perfectly valid key.
function isLikelyAssemblyKey(key) {
  return /^[A-Za-z0-9._-]{20,}$/.test(String(key || '').trim());
}

// SOAP JSON parsing (tolerant of fences, prose, and token-cutoff truncation) ----

function repairTruncatedJSON(raw) {
  let s = String(raw).replace(/,\s*$/, '');
  let quotes = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && s[i - 1] !== '\\') quotes++;
  }
  if (quotes % 2 !== 0) s += '"';
  let open = 0, close = 0;
  for (const c of s) { if (c === '{') open++; else if (c === '}') close++; }
  if (open > close) s += '}'.repeat(open - close);
  return s;
}

function parseSOAPResponse(rawText) {
  let raw = String(rawText || '').trim().replace(/```json|```/g, '').trim();
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first !== -1 && last > first) raw = raw.slice(first, last + 1);
  try {
    return JSON.parse(raw);
  } catch (e) {
    return JSON.parse(repairTruncatedJSON(raw));
  }
}

// Legacy draft recovery ----------------------------------------------------------
//
// The `scribe_draft` slot belonged to the Web Speech era, when the live text was
// the only copy of a session. Nothing writes it any more (the audio file is the
// recovery copy now), but the reader is kept so a draft left in localStorage from
// the previous build can still be restored on first load after the upgrade.

function isDraftRestorable(draft) {
  return !!draft && typeof draft.transcript === 'string' && draft.transcript.trim().length > 0;
}

// Session history upsert ---------------------------------------------------------
//
// Insert a session at the front of the list, or replace it in place if an entry
// with the same id already exists (a session is persisted at stop, then again
// when its transcript arrives and when its note is generated / edited). Returns a
// new array capped at `cap`.
function upsertSession(list, session, cap) {
  const sessions = (list || []).slice();
  const idx = sessions.findIndex(s => s.id === session.id);
  if (idx !== -1) sessions[idx] = session;
  else sessions.unshift(session);
  const max = cap || 100;
  return sessions.length > max ? sessions.slice(0, max) : sessions;
}

// Diagnostics report formatting (PHI-free) --------------------------------------
//
// Renders the metadata-only diagnostic log into a copy-pasteable block. Never
// receives transcript text — only event names, error codes, counts, timings.
function formatDiagnostics(entries, env) {
  const e = env || {};
  const lines = [];
  lines.push('WCP Scribe diagnostics');
  lines.push('generated: ' + (e.generatedAt || ''));
  lines.push('browser:   ' + (e.userAgent || 'unknown'));
  lines.push('audio mime: ' + (e.audioMime || 'unknown'));
  lines.push('session events (no patient text is recorded):');
  lines.push('----------------------------------------');
  for (const entry of (entries || [])) {
    const detail = entry.detail !== undefined && entry.detail !== null ? '  ' + entry.detail : '';
    lines.push((entry.t || '') + '  ' + entry.event + detail);
  }
  if (!entries || !entries.length) lines.push('(no events recorded)');
  return lines.join('\n');
}

// Node export (ignored in the browser, where `module` is undefined) -------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SAFETY_TERMS,
    AUDIO_MIME_CANDIDATES,
    ASSEMBLY_RATE_PER_HOUR,
    ASSEMBLY_FREE_GRANT,
    hasSafetyDoc,
    selectCPT,
    pickAudioMime,
    micErrorMessage,
    buildUtteranceTranscript,
    countWords,
    assemblyErrorMessage,
    noteErrorMessage,
    transcriptionLabel,
    needsTranscription,
    sessionHasNote,
    isInterruptedRecording,
    findInterruptedSessions,
    dayKey,
    groupSessionsByDay,
    dayLabel,
    selectAudioToPrune,
    estimateCost,
    creditStatus,
    formatUsd,
    hoursRemaining,
    isLikelyAnthropicKey,
    isLikelyAssemblyKey,
    repairTruncatedJSON,
    parseSOAPResponse,
    isDraftRestorable,
    upsertSession,
    formatDiagnostics,
  };
}
