// The pure, DOM-free logic lives in helpers.js, which index.html loads before
// this file (so hasSafetyDoc, selectCPT, buildTranscript, parseSOAPResponse,
// friendlyRecognitionError, formatDiagnostics, etc. are available as globals).

// ── State ────────────────────────────────────────────────────────────────────

let apiKey      = localStorage.getItem('scribe_key') || '';
let recognition = null;
let isRecording = false;       // user intends to be recording
let transcript  = '';
let timerInterval = null;
let timerSeconds  = 0;
let draftInterval = null;      // periodic auto-save while recording
let watchdogInterval = null;   // keeps recognition alive across Safari restarts
let lastResultTime = 0;        // timestamp of the last recognition result
let renderPending  = false;    // throttle for transcript DOM writes
let lastRenderTime = 0;
let restartCount   = 0;        // recognition restarts this session (diagnostics)
let sessionBase    = '';       // finalized text from prior recognition sessions
let hasResult      = false;    // have we transcribed anything this recording?
let recogRunning   = false;    // a recognition session is currently live
let starting       = false;    // a start() is in flight (awaiting onstart)
let reconnecting   = false;    // capture dropped; UI is showing "reconnecting"
let restartDelay   = 300;      // current backoff between restart attempts (ms)
let sessionHadSpeech = false;  // did the current recognition session capture speech?
let restartScheduled = false;  // a restart timer is already pending
let soapData    = null;
let sessions    = JSON.parse(localStorage.getItem('scribe_sessions') || '[]');
let viewMode    = false;
let viewSnapshot = null;
let pendingDraft = null;       // recovered draft awaiting restore/discard

const DRAFT_KEY      = 'scribe_draft';
const DIAG_KEY       = 'scribe_diag';
const DIAG_MAX       = 250;    // rolling diagnostic events kept
const RENDER_MS      = 400;    // at most one transcript repaint per 400ms
const RESTART_MIN_MS     = 300;   // fast restart mid-conversation (natural pauses)
const RESTART_SILENCE_MS = 2500;  // slower restart during pure silence (fewer beeps)
const RESTART_MAX_MS     = 5000;  // backoff cap when Safari keeps blocking restarts
const ZOMBIE_MS          = 40000; // running-but-silent this long → recreate recognizer

// ── Diagnostics (metadata only — never transcript text / PHI) ──────────────────

let diagLog = [];

function diag(event, detail) {
  const entry = { t: new Date().toISOString(), event };
  if (detail !== undefined && detail !== null) entry.detail = detail;
  diagLog.push(entry);
  if (diagLog.length > DIAG_MAX) diagLog = diagLog.slice(-DIAG_MAX);
  try { localStorage.setItem(DIAG_KEY, JSON.stringify(diagLog)); } catch (e) {}
}

function diagEnv() {
  return {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    speechSupported: ('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window),
  };
}

function copyDiagnostics() {
  const report = formatDiagnostics(diagLog, diagEnv());
  navigator.clipboard.writeText(report).then(() => {
    const btn = document.getElementById('copyDiagBtn');
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = 'Diagnostics copied';
    setTimeout(() => { btn.textContent = prev; }, 2000);
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

try { diagLog = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]'); } catch (e) { diagLog = []; }
diag('app_load', diagEnv().speechSupported ? 'speech:yes' : 'speech:no');

if (apiKey) {
  document.getElementById('setupCard').classList.add('hidden');
  document.getElementById('mainInterface').classList.remove('hidden');
  maybeOfferRestore();
}
renderSidebar();

// Auto-save safety net: persist the transcript if the tab is hidden or closed.
window.addEventListener('beforeunload', saveDraft);
window.addEventListener('pagehide', saveDraft);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // A hidden tab has its microphone suspended by the OS — save in case, and the
    // recognizer will drop. Nothing we can do about capture while backgrounded.
    saveDraft();
  } else if (isRecording && !recogRunning && !starting) {
    // Back in view (e.g. swiped away to a full-screen app and returned) — resume
    // capture immediately instead of waiting for the watchdog.
    diag('visible_resume');
    tryStartRecognition();
  }
});

// ── Auth ─────────────────────────────────────────────────────────────────────

function saveKey() {
  const val = document.getElementById('apiKeyInput').value.trim();
  if (!val.startsWith('sk-ant-')) {
    alert("That doesn't look like an Anthropic API key. It should start with sk-ant-");
    return;
  }
  apiKey = val;
  localStorage.setItem('scribe_key', val);
  document.getElementById('setupCard').classList.add('hidden');
  document.getElementById('mainInterface').classList.remove('hidden');
  maybeOfferRestore();
}

// ── Recording ────────────────────────────────────────────────────────────────

function toggleRecord() {
  if (!isRecording) startRecording();
  else stopRecording();
}

function startRecording() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    showError('Speech recognition is not supported in this browser. Please use Chrome or Edge.');
    return;
  }

  // Reset per-recording state, then build and start the recognizer.
  sessionBase      = '';
  hasResult        = false;
  recogRunning     = false;
  starting         = false;
  reconnecting     = false;
  sessionHadSpeech = false;
  restartScheduled = false;
  restartDelay     = RESTART_MIN_MS;
  restartCount     = 0;
  lastResultTime   = Date.now();
  isRecording      = true;

  diag('record_start');
  hideRestore();          // starting fresh — dismiss any leftover recovery banner
  hideError();
  recognition = makeRecognition();
  tryStartRecognition();

  document.getElementById('recordBtn').classList.add('recording');
  document.getElementById('micIcon').style.display = 'none';
  document.getElementById('stopIcon').style.display = 'block';
  document.getElementById('recordLabel').textContent = 'Recording — tap to stop';
  document.getElementById('statusDot').className = 'status-dot live';
  document.getElementById('ring1').classList.add('active');
  document.getElementById('ring2').classList.add('active');
  document.getElementById('ring3').classList.add('active');
  document.getElementById('transcriptSection').classList.add('visible');
  document.getElementById('transcriptCursor').classList.remove('hidden');
  document.getElementById('waveform').classList.add('active');
  document.getElementById('timer').classList.add('visible');

  timerSeconds = 0;
  timerInterval = setInterval(() => {
    timerSeconds++;
    const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
    const s = String(timerSeconds % 60).padStart(2, '0');
    document.getElementById('timer').textContent = m + ':' + s;
  }, 1000);

  // The waveform animates purely in CSS now (no per-frame JS / layout thrash).

  // Persist the transcript every 10s so a browser timeout can't lose the intake.
  draftInterval = setInterval(saveDraft, 10000);

  // Watchdog: keep recognition alive without churning it. It does NOT stop a
  // healthy session on mere silence (that was triggering Safari's restart-abuse
  // block). It only acts when capture is actually down, or a session has gone
  // silent-but-"running" for an implausibly long time (a Safari zombie).
  watchdogInterval = setInterval(() => {
    if (!isRecording) return;
    if (!recogRunning && !starting && !restartScheduled) {
      diag('watchdog', 'capture-down; restarting');
      setCapturing(false);
      tryStartRecognition();
    } else if (recogRunning && Date.now() - lastResultTime > ZOMBIE_MS) {
      diag('watchdog', 'zombie; recreating');
      recreateRecognition();
      scheduleRestart(RESTART_MIN_MS);
    }
  }, 4000);
}

// Build a configured SpeechRecognition with all handlers wired to module state.
function makeRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = 'en-US';

  r.onstart = () => {
    starting = false;
    recogRunning = true;
    sessionHadSpeech = false;   // fresh session — no speech captured yet
    diag('recognition_started');
  };

  r.onresult = (e) => {
    const results = [];
    for (let i = 0; i < e.results.length; i++) {
      results.push({ transcript: e.results[i][0].transcript, isFinal: e.results[i].isFinal });
    }
    const built = buildTranscript(sessionBase, results);
    transcript = built.text;
    r._lastFinal = built.final;   // carried into sessionBase on restart
    hasResult = true;
    sessionHadSpeech = true;
    lastResultTime = Date.now();
    restartDelay = RESTART_MIN_MS;   // real capture — reset backoff
    setCapturing(true);              // clears any "reconnecting" state
    // We're clearly capturing — clear any earlier (transient) error banner.
    if (document.getElementById('errorMsg').classList.contains('visible')) hideError();
    scheduleTranscriptRender();
    document.getElementById('generateBtn').classList.add('ready');
  };

  r.onerror = (e) => {
    diag('recognition_error', e.error);
    starting = false;
    // Only alarm the user for a *persistent* block: never captured anything AND
    // we've already retried a couple of times (Safari throws a spurious
    // not-allowed on some restarts that recovers on its own). This avoids
    // flashing a scary banner for a one-off hiccup at the very start.
    if (!hasResult && restartCount >= 2 && !isTransientRecognitionError(e.error)) {
      showError(friendlyRecognitionError(e.error));
    }
  };

  r.onend = () => {
    recogRunning = false;
    starting = false;
    if (isRecording) {
      sessionBase = r._lastFinal || transcript;
      // Restart fast if we were mid-conversation (a natural pause), slower if the
      // session heard nothing (pure silence) so we don't churn/beep every ~5s.
      const delay = sessionHadSpeech ? RESTART_MIN_MS : RESTART_SILENCE_MS;
      diag('recognition_end', sessionHadSpeech ? 'restart-fast' : 'restart-idle');
      scheduleRestart(delay);
    } else {
      diag('recognition_end', 'stopped');
    }
  };

  return r;
}

function scheduleRestart(delay) {
  if (restartScheduled) return;
  restartScheduled = true;
  restartCount++;
  setTimeout(() => {
    restartScheduled = false;
    if (isRecording) tryStartRecognition();
  }, delay != null ? delay : restartDelay);
}

// Start recognition, tolerating Safari's habit of throwing on rapid restarts.
// On failure it backs off exponentially and recreates the recognizer, and never
// gives up while the user still intends to record.
function tryStartRecognition() {
  if (!isRecording || recogRunning || starting) return;
  starting = true;
  try {
    recognition.start();
    // If onstart never confirms, clear the flag so the watchdog can retry.
    setTimeout(() => { starting = false; }, 1500);
  } catch (e) {
    starting = false;
    diag('start_throw', (e && e.name) || 'error');
    setCapturing(false);
    restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
    recreateRecognition();
    scheduleRestart(restartDelay);
  }
}

// Detach the old recognizer's handlers and build a fresh one (Safari sometimes
// wedges an instance so only a new object will start cleanly).
function recreateRecognition() {
  if (recognition) {
    try { recognition.onend = recognition.onerror = recognition.onresult = recognition.onstart = null; } catch (e) {}
    try { recognition.abort ? recognition.abort() : recognition.stop(); } catch (e) {}
  }
  recogRunning = false;
  starting = false;
  recognition = makeRecognition();
}

// Toggle the honest "reconnecting" vs "recording" status. Capture being down
// means audio is genuinely being missed, so we say so rather than pretend.
function setCapturing(alive) {
  const label = document.getElementById('recordLabel');
  const dot   = document.getElementById('statusDot');
  if (alive) {
    if (!reconnecting) return;
    reconnecting = false;
    if (isRecording) {
      label.textContent = 'Recording — tap to stop';
      dot.className = 'status-dot live';
    }
    if (document.getElementById('errorMsg').classList.contains('visible')) hideError();
  } else {
    if (reconnecting || !isRecording) return;
    reconnecting = true;
    if (hasResult) {
      // We had a working stream and lost it — be honest that audio may be missed.
      label.textContent = 'Reconnecting to speech service — audio may be missed briefly';
      dot.className = 'status-dot reconnecting';
      diag('reconnecting');
    } else {
      // Nothing captured yet — this is just Safari's no-speech timeout cycling
      // while the room is quiet. Keep it calm; we're armed and waiting.
      label.textContent = 'Listening — start speaking to begin the transcript';
      dot.className = 'status-dot live';
      diag('listening_idle');
    }
  }
}

function stopRecording() {
  isRecording = false;   // set first so onend does not schedule a restart
  recogRunning = false;
  starting = false;
  reconnecting = false;
  restartScheduled = false;
  if (recognition) { try { recognition.stop(); } catch (e) {} }
  clearInterval(timerInterval);
  clearInterval(draftInterval);
  clearInterval(watchdogInterval);
  saveDraft();
  diag('record_stop', 'dur:' + timerSeconds + 's restarts:' + restartCount);

  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('micIcon').style.display = 'block';
  document.getElementById('stopIcon').style.display = 'none';
  document.getElementById('recordLabel').textContent = 'Session ended';
  document.getElementById('statusDot').className = 'status-dot done';
  document.getElementById('ring1').classList.remove('active');
  document.getElementById('ring2').classList.remove('active');
  document.getElementById('ring3').classList.remove('active');
  document.getElementById('waveform').classList.remove('active');
  document.getElementById('transcriptCursor').classList.add('hidden');

  updateTranscriptDisplay(transcript);
  checkSafetyDoc();
}

function updateTranscriptDisplay(text) {
  if (text.trim()) {
    document.getElementById('transcriptPlaceholder').style.display = 'none';
    document.getElementById('transcriptText').textContent = text;
  }
}

// Throttle DOM writes: re-rendering the whole (growing) transcript on every
// interim result is what heats an older laptop up. Repaint at most every 400ms.
function scheduleTranscriptRender() {
  const now = Date.now();
  const elapsed = now - lastRenderTime;
  if (elapsed >= RENDER_MS) {
    lastRenderTime = now;
    updateTranscriptDisplay(transcript);
  } else if (!renderPending) {
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      lastRenderTime = Date.now();
      updateTranscriptDisplay(transcript);
    }, RENDER_MS - elapsed);
  }
}

// ── Auto-save / crash recovery ─────────────────────────────────────────────────

function saveDraft() {
  if (!transcript.trim()) return;
  try {
    localStorage.setItem(DRAFT_KEY, serializeDraft(transcript, timerSeconds, new Date().toISOString()));
    diag('draft_saved', 'len:' + transcript.length);
  } catch (e) {}
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); }
  catch (e) { return null; }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
}

function maybeOfferRestore() {
  const draft = loadDraft();
  if (!isDraftRestorable(draft)) return;
  pendingDraft = draft;
  const when = draft.savedAt ? new Date(draft.savedAt) : null;
  document.getElementById('restoreBannerText').textContent =
    'Recovered an unsaved transcript' +
    (when ? ' from ' + when.toLocaleString() : '') + '. Restore it?';
  document.getElementById('restoreBanner').classList.remove('hidden');
}

function restoreDraft() {
  if (!pendingDraft) return;
  transcript   = pendingDraft.transcript || '';
  timerSeconds = pendingDraft.duration || 0;
  pendingDraft = null;

  const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
  const s = String(timerSeconds % 60).padStart(2, '0');
  document.getElementById('timer').textContent = m + ':' + s;
  document.getElementById('timer').classList.add('visible');
  document.getElementById('transcriptText').textContent = transcript;
  document.getElementById('transcriptPlaceholder').style.display = 'none';
  document.getElementById('transcriptSection').classList.add('visible');
  document.getElementById('generateBtn').classList.add('ready');
  document.getElementById('recordLabel').textContent = 'Recovered — review, then Generate SOAP Note';
  checkSafetyDoc();
  diag('draft_restored');
  hideRestore();
}

function discardDraft() {
  pendingDraft = null;
  clearDraft();
  hideRestore();
}

function hideRestore() {
  document.getElementById('restoreBanner').classList.add('hidden');
}

// ── SOAP generation ──────────────────────────────────────────────────────────

const SOAP_PROMPT = `You are a medical scribe assistant for a psychiatrist. Below is a raw transcript from a patient session. Convert it into a structured SOAP note.

Return ONLY a JSON object with exactly these four keys: "S", "O", "A", "P"

- S (Subjective): Patient's reported symptoms, concerns, history in their own words. Include chief complaint, HPI, and any relevant personal/social history mentioned.
- O (Objective): Format as a structured Mental Status Exam with each field on its own line:
  Appearance: [dress, grooming]
  Behavior: [eye contact, psychomotor, cooperation]
  Speech: [rate, rhythm, volume]
  Mood: [patient's own words in quotes]
  Affect: [range, intensity, congruence with mood]
  Thought Process: [linear / tangential / circumstantial / etc]
  Thought Content: [SI/HI/AVH/delusions — explicitly note denial if not mentioned]
  Cognition: [orientation, memory, concentration]
  Insight: [good / fair / poor]
  Judgment: [good / fair / poor]
  Use only information in the transcript. Write "Not documented" for any field not mentioned.
- A (Assessment): Clinical impression, working diagnosis or differential, and any changes from prior sessions if mentioned.
- P (Plan): Treatment plan, medication changes, referrals, follow-up timeline, psychotherapy approach, patient instructions.

Be concise but clinically complete. Use proper psychiatric terminology. Do not add information not present in the transcript.

TRANSCRIPT:
{{transcript}}

Respond with only the JSON object, no markdown, no explanation.`;

async function generateSOAP() {
  if (!transcript.trim()) return;
  if (isRecording) stopRecording();

  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating...';
  hideError();
  diag('generate_start', 'transcriptLen:' + transcript.length);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: SOAP_PROMPT.replace('{{transcript}}', transcript) }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'API error ' + response.status);
    }

    const data = await response.json();
    const parsed = parseSOAPResponse(data.content[0].text);

    document.getElementById('soapS').textContent = parsed.S || '—';
    document.getElementById('soapO').textContent = parsed.O || '—';
    document.getElementById('soapA').textContent = parsed.A || '—';
    document.getElementById('soapP').textContent = parsed.P || '—';
    soapData = parsed;

    showCPT();
    document.getElementById('soapSection').classList.add('visible');
    document.getElementById('soapSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('statusDot').className = 'status-dot done';
    document.getElementById('recordBtn').disabled = true;
    document.getElementById('recordLabel').textContent = 'Note generated — click New Session to continue';
    diag('generate_ok');

  } catch (err) {
    diag('generate_error', err.message);
    showError('Error generating note: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Generate SOAP Note';
    btn.classList.add('ready');
  }
}

// ── Safety & CPT ─────────────────────────────────────────────────────────────

function checkSafetyDoc() {
  const found = hasSafetyDoc(transcript);
  const el = document.getElementById('safetyWarning');
  if (!found && transcript.trim().length > 30) el.classList.add('visible');
  else el.classList.remove('visible');
}

function showCPT() {
  const pairs = selectCPT(timerSeconds);
  if (!pairs.length) return;

  const chips = pairs.map(([code, label], i) =>
    (i > 0 ? '<span class="cpt-sep">·</span>' : '') +
    `<span class="cpt-chip" onclick="navigator.clipboard.writeText('${code}')" title="Click to copy">` +
    `${code}<span class="cpt-chip-label">${label}</span></span>`
  ).join('');

  document.getElementById('cptChips').innerHTML = chips;
  document.getElementById('cptRow').classList.add('visible');
}

// ── Clipboard ────────────────────────────────────────────────────────────────

const COPY_ICON_SM  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON_SM = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const COPY_ICON_XS  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON_XS = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function copySOAP() {
  const S = document.getElementById('soapS').textContent;
  const O = document.getElementById('soapO').textContent;
  const A = document.getElementById('soapA').textContent;
  const P = document.getElementById('soapP').textContent;
  if (!S && !O && !A && !P) return;

  const text = `SOAP NOTE\n\nSUBJECTIVE\n${S}\n\nOBJECTIVE\n${O}\n\nASSESSMENT\n${A}\n\nPLAN\n${P}`;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.classList.add('copied');
    btn.innerHTML = CHECK_ICON_SM + ' Copied';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = COPY_ICON_SM + ' Copy';
    }, 2500);
  });
}

function copySection(sectionId, btnEl) {
  const text = document.getElementById(sectionId).textContent.trim();
  if (!text || text === '—') return;
  navigator.clipboard.writeText(text).then(() => {
    btnEl.classList.add('copied');
    btnEl.innerHTML = CHECK_ICON_XS + ' Copied';
    setTimeout(() => {
      btnEl.classList.remove('copied');
      btnEl.innerHTML = COPY_ICON_XS + ' Copy';
    }, 2000);
  });
}

// ── Session history ───────────────────────────────────────────────────────────

function formatDuration(s) {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

function renderSidebar() {
  const list = document.getElementById('sessionList');
  if (!sessions.length) {
    list.innerHTML = '<div class="session-empty">Sessions appear here after you click New Session</div>';
    return;
  }
  list.innerHTML = sessions.map(s => {
    const d       = new Date(s.date);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const preview = s.transcript
      ? s.transcript.slice(0, 50).trim() + (s.transcript.length > 50 ? '…' : '')
      : 'No transcript';
    const dur = formatDuration(s.duration);
    return `<div class="session-item" data-id="${s.id}" onclick="viewSession(${s.id})">
      <div class="session-item-meta">
        <span class="session-item-date">${dateStr} · ${timeStr}</span>
        ${dur ? `<span class="session-item-dur">${dur}</span>` : ''}
      </div>
      <div class="session-item-preview">${preview}</div>
    </div>`;
  }).join('');
}

function saveCurrentSession() {
  const hasSoap = document.getElementById('soapS').textContent.trim().length > 0;
  if (!transcript.trim() && !hasSoap) return;
  const session = {
    id:         Date.now(),
    date:       new Date().toISOString(),
    duration:   timerSeconds,
    transcript: transcript,
    soap: {
      S: document.getElementById('soapS').textContent,
      O: document.getElementById('soapO').textContent,
      A: document.getElementById('soapA').textContent,
      P: document.getElementById('soapP').textContent,
    }
  };
  sessions.unshift(session);
  if (sessions.length > 100) sessions = sessions.slice(0, 100);
  localStorage.setItem('scribe_sessions', JSON.stringify(sessions));
  clearDraft();  // transcript is safely in history now — drop the recovery copy
  renderSidebar();
}

function viewSession(id) {
  const session = sessions.find(s => s.id === id);
  if (!session) return;

  if (!viewMode) {
    viewSnapshot = {
      transcript,
      soapS:              document.getElementById('soapS').textContent,
      soapO:              document.getElementById('soapO').textContent,
      soapA:              document.getElementById('soapA').textContent,
      soapP:              document.getElementById('soapP').textContent,
      transcriptVisible:  document.getElementById('transcriptSection').classList.contains('visible'),
      soapVisible:        document.getElementById('soapSection').classList.contains('visible'),
      cptVisible:         document.getElementById('cptRow').classList.contains('visible'),
      cptHTML:            document.getElementById('cptChips').innerHTML,
      generateReady:      document.getElementById('generateBtn').classList.contains('ready'),
      generateDisabled:   document.getElementById('generateBtn').disabled,
      recordDisabled:     document.getElementById('recordBtn').disabled,
      recordLabel:        document.getElementById('recordLabel').textContent,
    };
  }

  viewMode = true;
  if (isRecording) stopRecording();

  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.session-item[data-id="${id}"]`)?.classList.add('active');

  const d = new Date(session.date);
  document.getElementById('viewingBannerDate').textContent =
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  document.getElementById('viewingBanner').classList.remove('hidden');
  document.getElementById('recordSection').classList.add('hidden');
  document.getElementById('transcriptPlaceholder').style.display = 'none';
  document.getElementById('transcriptText').textContent = session.transcript || '';
  document.getElementById('transcriptCursor').classList.add('hidden');
  document.getElementById('transcriptSection').classList.add('visible');
  document.getElementById('generateBtn').classList.add('hidden');
  document.getElementById('safetyWarning').classList.remove('visible');
  document.querySelector('.new-session-btn').classList.add('hidden');
  document.getElementById('cptRow').classList.remove('visible');
  hideError();

  if (session.soap) {
    document.getElementById('soapS').textContent = session.soap.S || '—';
    document.getElementById('soapO').textContent = session.soap.O || '—';
    document.getElementById('soapA').textContent = session.soap.A || '—';
    document.getElementById('soapP').textContent = session.soap.P || '—';
    ['soapS', 'soapO', 'soapA', 'soapP'].forEach(id => document.getElementById(id).removeAttribute('contenteditable'));
    document.getElementById('soapSection').classList.add('visible');
  } else {
    document.getElementById('soapSection').classList.remove('visible');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function exitViewMode() {
  if (!viewMode) return;
  viewMode = false;

  document.getElementById('viewingBanner').classList.add('hidden');
  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  ['soapS', 'soapO', 'soapA', 'soapP'].forEach(id => document.getElementById(id).setAttribute('contenteditable', 'true'));
  document.getElementById('recordSection').classList.remove('hidden');
  document.getElementById('generateBtn').classList.remove('hidden');
  document.querySelector('.new-session-btn').classList.remove('hidden');

  if (!viewSnapshot) return;
  const snap = viewSnapshot;
  viewSnapshot = null;

  transcript = snap.transcript;
  document.getElementById('transcriptText').textContent = snap.transcript || '';
  document.getElementById('transcriptPlaceholder').style.display = snap.transcript ? 'none' : '';

  snap.transcriptVisible
    ? document.getElementById('transcriptSection').classList.add('visible')
    : document.getElementById('transcriptSection').classList.remove('visible');

  if (snap.soapVisible) {
    document.getElementById('soapS').textContent = snap.soapS;
    document.getElementById('soapO').textContent = snap.soapO;
    document.getElementById('soapA').textContent = snap.soapA;
    document.getElementById('soapP').textContent = snap.soapP;
    document.getElementById('soapSection').classList.add('visible');
  } else {
    document.getElementById('soapSection').classList.remove('visible');
  }

  if (snap.cptVisible) {
    document.getElementById('cptChips').innerHTML = snap.cptHTML;
    document.getElementById('cptRow').classList.add('visible');
  } else {
    document.getElementById('cptRow').classList.remove('visible');
  }

  snap.generateReady
    ? document.getElementById('generateBtn').classList.add('ready')
    : document.getElementById('generateBtn').classList.remove('ready');
  document.getElementById('generateBtn').disabled = snap.generateDisabled;
  document.getElementById('recordBtn').disabled   = snap.recordDisabled;
  document.getElementById('recordLabel').textContent = snap.recordLabel;
}

// ── Session reset ─────────────────────────────────────────────────────────────

function newSession() {
  if (!viewMode) saveCurrentSession();
  exitViewMode();

  transcript = '';
  soapData   = null;
  timerSeconds = 0;

  document.getElementById('timer').textContent = '00:00';
  document.getElementById('timer').classList.remove('visible');
  document.getElementById('transcriptText').textContent = '';
  document.getElementById('transcriptPlaceholder').style.display = '';
  document.getElementById('transcriptSection').classList.remove('visible');
  document.getElementById('soapSection').classList.remove('visible');
  ['soapS', 'soapO', 'soapA', 'soapP'].forEach(id => document.getElementById(id).textContent = '');
  document.getElementById('cptRow').classList.remove('visible');
  document.getElementById('safetyWarning').classList.remove('visible');
  document.getElementById('generateBtn').classList.remove('ready');
  document.getElementById('recordBtn').disabled = false;
  document.getElementById('recordLabel').textContent = 'Tap to begin session';
  document.getElementById('statusDot').className = 'status-dot';
  hideError();
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.add('visible');
  // Reveal the "Copy diagnostics" affordance only while an error is showing.
  const diagBtn = document.getElementById('copyDiagBtn');
  if (diagBtn) diagBtn.classList.remove('hidden');
}

function hideError() {
  document.getElementById('errorMsg').classList.remove('visible');
  const diagBtn = document.getElementById('copyDiagBtn');
  if (diagBtn) diagBtn.classList.add('hidden');
}
