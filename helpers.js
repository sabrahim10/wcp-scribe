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

// Transcript assembly -----------------------------------------------------------
//
// Rebuilds the transcript from the recognition result list every event, rather
// than blindly appending. This fixes Safari's habit of re-emitting/duplicating
// final results (which would otherwise double up the text). `base` carries text
// finalized in earlier recognition sessions across the restart loop.
//   results: array of { transcript, isFinal }
// Returns { text, final } — `text` includes live interim words; `final` is the
// stable portion to carry into `base` on the next restart.
function buildTranscript(base, results) {
  let final = '';
  let interim = '';
  let prevFinal = null;
  for (const r of (results || [])) {
    const t = r.transcript || '';
    if (r.isFinal) {
      const trimmed = t.trim();
      if (trimmed && trimmed === prevFinal) continue; // drop Safari re-emit
      prevFinal = trimmed;
      final += t.trim() + ' ';
    } else {
      interim += t;
    }
  }
  const baseStr = base || '';
  return { text: (baseStr + final + interim), final: (baseStr + final) };
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

// Auto-save / crash recovery ----------------------------------------------------

function serializeDraft(text, seconds, nowIso) {
  return JSON.stringify({ transcript: text, duration: seconds, savedAt: nowIso });
}

function isDraftRestorable(draft) {
  return !!draft && typeof draft.transcript === 'string' && draft.transcript.trim().length > 0;
}

// Session history upsert ---------------------------------------------------------
//
// Insert a session at the front of the list, or replace it in place if an entry
// with the same id already exists (a session is persisted at stop, then again
// when its note is generated / edited). Returns a new array capped at `cap`.
function upsertSession(list, session, cap) {
  const sessions = (list || []).slice();
  const idx = sessions.findIndex(s => s.id === session.id);
  if (idx !== -1) sessions[idx] = session;
  else sessions.unshift(session);
  const max = cap || 100;
  return sessions.length > max ? sessions.slice(0, max) : sessions;
}

// Human-readable messages for known SpeechRecognition failures ------------------
//
// Safari's error codes are cryptic and several map to fixable system settings
// (see tests/SAFARI_CHECKLIST.md). Turn them into something a clinician can act on.
function friendlyRecognitionError(code) {
  switch (code) {
    case 'not-allowed':
      return 'Microphone/speech access was blocked. Allow it for this site, and make sure macOS Dictation is on (System Settings ▸ Keyboard ▸ Dictation).';
    case 'service-not-available':
      return 'The speech service is unavailable. On macOS, turn Dictation ON (System Settings ▸ Keyboard ▸ Dictation), then reload and try again.';
    case 'network':
      return 'Lost connection to the speech service — reconnecting…';
    case 'audio-capture':
      return 'No microphone was found. Check that the mic is connected and selected in System Settings ▸ Sound.';
    case 'aborted':
      return 'Recording was interrupted — restarting…';
    default:
      return 'Microphone error: ' + code;
  }
}

// Whether an error code should be shown to the user (vs. handled silently) -------
function isTransientRecognitionError(code) {
  return code === 'no-speech' || code === 'aborted' || code === 'network';
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
  lines.push('speech supported: ' + (e.speechSupported ? 'yes' : 'no'));
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
    hasSafetyDoc,
    selectCPT,
    buildTranscript,
    repairTruncatedJSON,
    parseSOAPResponse,
    serializeDraft,
    isDraftRestorable,
    upsertSession,
    friendlyRecognitionError,
    isTransientRecognitionError,
    formatDiagnostics,
  };
}
