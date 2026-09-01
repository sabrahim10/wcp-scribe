// The pure, DOM-free logic lives in helpers.js, which index.html loads before
// this file (so hasSafetyDoc, selectCPT, pickAudioMime, buildUtteranceTranscript,
// assemblyErrorMessage, parseSOAPResponse, formatDiagnostics, etc. are globals).
//
// Recording model (Tier 2): the microphone is captured with MediaRecorder and
// written to IndexedDB in 5-second chunks *as it records*. Transcription happens
// after the session ends, by uploading that audio to AssemblyAI. There is no
// live speech recognition any more — which means there is no longer any way for
// speech to be "missed": the audio is on disk before anything else is attempted,
// so every downstream failure (no credits, no wifi, bad key, closed tab) delays a
// note instead of losing one.

// ── State ────────────────────────────────────────────────────────────────────

let apiKey      = localStorage.getItem('scribe_key') || '';
let assemblyKey = localStorage.getItem('scribe_assembly_key') || '';
let isRecording = false;
let transcript  = '';
let timerInterval = null;
let timerSeconds  = 0;
let timerStartedAt = 0;   // wall-clock start; setInterval ticks are throttled

// Which day folders are open in the sidebar. Declared up here, not beside
// renderSidebar, because renderSidebar() runs during initial script execution —
// a `const` further down the file is still in its temporal dead zone at that
// point and the sidebar dies with "Cannot access 'openDaysSeeded' before
// initialization". Same trap that took out `sleep` and cost a 40-minute intake.
const openDays = new Set();
let openDaysSeeded = false;
let soapData    = null;
let sessions    = JSON.parse(localStorage.getItem('scribe_sessions') || '[]');
let viewMode    = false;
let viewSnapshot = null;
let pendingDraft = null;       // legacy Web Speech draft awaiting restore/discard
let currentSessionId = null;   // history id for the in-progress session
let sessionStartISO  = null;   // when recording began — sessions are dated by this
let viewingSessionId = null;   // id of the history session open in view mode

// Audio capture
let mediaStream   = null;
let mediaRecorder = null;
let audioMime     = '';
let chunkSeq      = 0;
let chunkErrors   = 0;
let audioCtx      = null;
let analyserNode  = null;
let meterRAF      = null;
let sawSound      = false;
let meterTicks    = 0;    // samples actually taken — see checkSilence()
let silenceTimer  = null;

// Transcription. A run is deliberately never cancelled: once audio is submitted the
// result is already paid for, so an in-flight job keeps going even if the user moves
// on to a new session — it just writes to its own history entry instead of the screen.
const inFlight = new Set();    // session ids currently being transcribed

const DRAFT_KEY  = 'scribe_draft';
const DIAG_KEY   = 'scribe_diag';
const USAGE_KEY  = 'scribe_usage';
const DIAG_MAX   = 250;        // rolling diagnostic events kept
const CHUNK_MS   = 5000;       // audio flushed to IndexedDB every 5s
const METER_MS   = 80;         // level meter repaint gate (~12fps)
const AUDIO_BPS  = 64000;      // 64 kbps — ample for speech, ~21 MB per hour
const POLL_MS    = 3000;       // AssemblyAI status poll interval
const POLL_MAX_MS = 30 * 60 * 1000;
const SILENCE_HINT_MS = 20000; // no sound at all this long → likely wrong input
const AUDIO_KEEP_RECENT = 10;  // recordings kept regardless of note status

// Declared up here, not next to transcribeSession, because resumeUnfinishedWork()
// runs during initial script execution — before a `const` further down the file
// has been initialized. Resuming a job that already has an assemblyId reaches the
// poll loop with no preceding await, so a later declaration is still in its
// temporal dead zone and every resumed transcription died with
// "Cannot access 'sleep' before initialization".
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ASSEMBLY_BASE = 'https://api.assemblyai.com';

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
    audioMime: audioMime || pickAudioMime(mimeSupported) || 'browser default',
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

// Hand-edits to the SOAP fields are saved as soon as the field loses focus —
// closing the tab without clicking New Session no longer drops them.
['soapS', 'soapO', 'soapA', 'soapP'].forEach(id =>
  document.getElementById(id).addEventListener('blur', () => { if (!viewMode) persistSession(); }));

// Recording survives a backgrounded tab now (MediaRecorder is not suspended the
// way SpeechRecognition was), so there is nothing to resume on visibility change.
// A close mid-recording still keeps every chunk already flushed to IndexedDB.
window.addEventListener('pagehide', () => {
  if (isRecording) diag('pagehide_recording', 'chunks:' + chunkSeq);
});

// The recording itself is unaffected by backgrounding, but the AudioContext
// behind the level meter is suspended, so it comes back reporting silence.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isRecording && audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
});

// ── Auth / settings ──────────────────────────────────────────────────────────

function hasKeys() { return !!apiKey && !!assemblyKey; }

function showMain() {
  document.getElementById('setupCard').classList.add('hidden');
  document.getElementById('mainInterface').classList.remove('hidden');
  document.getElementById('newSessionTop').classList.remove('hidden');
}

function prefillSetup() {
  document.getElementById('apiKeyInput').value = apiKey;
  document.getElementById('assemblyKeyInput').value = assemblyKey;
  document.getElementById('setupCard').classList.remove('hidden');
}

function showSettings() {
  prefillSetup();
  document.getElementById('setupCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function saveKeys() {
  const anthropic = document.getElementById('apiKeyInput').value.trim();
  const assembly  = document.getElementById('assemblyKeyInput').value.trim();
  const err = document.getElementById('setupError');

  if (!isLikelyAnthropicKey(anthropic)) {
    err.textContent = "That doesn't look like an Anthropic key — it should start with sk-ant-";
    err.classList.add('visible');
    return;
  }
  if (!isLikelyAssemblyKey(assembly)) {
    err.textContent = "That doesn't look like an AssemblyAI key — copy it from assemblyai.com/app.";
    err.classList.add('visible');
    return;
  }

  apiKey = anthropic;
  assemblyKey = assembly;
  localStorage.setItem('scribe_key', anthropic);
  localStorage.setItem('scribe_assembly_key', assembly);
  err.classList.remove('visible');
  showMain();
  maybeOfferRestore();
  resumeUnfinishedWork();
  renderCredits();
}

// ── Audio store (IndexedDB) ───────────────────────────────────────────────────
//
// localStorage cannot hold audio (5 MB cap, strings only). Chunks are stored
// individually under [sessionId, seq] so each 5-second flush is a small write
// rather than a rewrite of the whole growing recording.

const AUDIO_DB = 'scribe_audio';
const AUDIO_STORE = 'chunks';
let audioDbPromise = null;

function audioDB() {
  if (audioDbPromise) return audioDbPromise;
  audioDbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(AUDIO_DB, 1); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        const store = db.createObjectStore(AUDIO_STORE, { keyPath: ['sessionId', 'seq'] });
        store.createIndex('bySession', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return audioDbPromise;
}

function putAudioChunk(sessionId, seq, blob, mime) {
  return audioDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).put({ sessionId, seq, blob, mime });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error);
  }));
}

// Chunk sequence numbers for a session — keys only, so this stays cheap even
// for a 750-chunk recording.
function getAudioSeqs(sessionId) {
  return audioDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(AUDIO_STORE, 'readonly').objectStore(AUDIO_STORE)
                  .index('bySession').getAllKeys(sessionId);
    req.onsuccess = () => resolve((req.result || []).map(k => k[1]).sort((a, b) => a - b));
    req.onerror = () => reject(req.error);
  }));
}

function getAudioChunk(sessionId, seq) {
  return audioDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(AUDIO_STORE, 'readonly').objectStore(AUDIO_STORE)
                  .get([sessionId, seq]);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

// Reassemble a session's audio into one uploadable file.
//
// Safari returns Blob references from IndexedDB that stop resolving once the
// transaction that produced them has completed: `.size` keeps reporting the
// right number, but reading the bytes yields a truncated result, or nothing.
// Building the upload body from a single getAll() therefore put short, garbled
// bodies on the wire — a 31-minute session uploaded 10.6 MB of an expected
// ~38 MB, then 114 KB on retry — which AssemblyAI rejects as an unidentifiable
// "(data)" file. It looked non-deterministic because it is.
//
// So each chunk's bytes are pulled while that chunk's own transaction is still
// alive, and the assembled length is checked against what the chunks claim.
// A short read fails here, loudly, instead of becoming a confusing rejection
// several minutes later.
async function getAudioBlob(sessionId) {
  const seqs = await getAudioSeqs(sessionId);
  if (!seqs.length) return null;

  const parts = [];
  let declared = 0, actual = 0, mime = '';
  for (const seq of seqs) {
    const row = await getAudioChunk(sessionId, seq);
    if (!row || !row.blob) continue;
    if (!mime) mime = row.mime || '';
    declared += row.blob.size;
    const buf = await row.blob.arrayBuffer();
    actual += buf.byteLength;
    // Re-wrap as a Blob immediately rather than keeping the ArrayBuffer: an
    // hour-long visit is ~41 MB, and holding all of it in the JS heap (plus a
    // copy when the final Blob is built) is a good way to provoke exactly the
    // memory-pressure tab discard this tier exists to prevent. Blobs can be
    // backed by disk; each buffer is collectable as soon as it is wrapped.
    parts.push(new Blob([buf]));
  }

  if (!actual) return null;
  if (actual !== declared || parts.length !== seqs.length) {
    diag('audio_assembly_short',
         'chunks:' + parts.length + '/' + seqs.length + ' bytes:' + actual + '/' + declared);
    throw new Error('Only part of this recording could be read back from the browser (' +
      parts.length + ' of ' + seqs.length + ' pieces). Nothing was sent, and the audio is ' +
      'still saved — retry, and if it keeps failing use the recovery page to save the file.');
  }
  diag('audio_assembled', 'chunks:' + parts.length + ' bytes:' + actual);
  return new Blob(parts, { type: mime || 'audio/webm' });
}

function deleteAudio(sessionId) {
  return audioDB().then(db => new Promise((resolve) => {
    const tx    = db.transaction(AUDIO_STORE, 'readwrite');
    const store = tx.objectStore(AUDIO_STORE);
    const req   = store.index('bySession').getAllKeys(sessionId);
    req.onsuccess = () => { (req.result || []).forEach(k => store.delete(k)); };
    tx.oncomplete = () => resolve();
    tx.onerror    = () => resolve();   // best-effort cleanup, never fatal
  })).catch(() => {});
}

// Drop audio for old sessions that already have a finished note. Never touches a
// session that still owes a transcript or a note — that audio is the only copy.
function pruneAudio() {
  const ids = selectAudioToPrune(sessions, AUDIO_KEEP_RECENT);
  if (!ids.length) return;
  Promise.all(ids.map(deleteAudio)).then(() => {
    let changed = false;
    ids.forEach(id => {
      const s = sessions.find(x => x.id === id);
      if (s && s.hasAudio) { s.hasAudio = false; s.updatedAt = Date.now(); changed = true; }
    });
    if (changed) saveSessions();
    diag('audio_pruned', 'count:' + ids.length);
  });
}

// ── Recording ────────────────────────────────────────────────────────────────

function mimeSupported(type) {
  try { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type); }
  catch (e) { return false; }
}

function toggleRecord() {
  if (!isRecording) startRecording();
  else stopRecording();
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    showError('This browser cannot record audio. Please use a current version of Safari, Chrome, or Edge.');
    return;
  }

  hideError();
  hideRestore();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    diag('mic_error', (e && e.name) || 'error');
    showError(micErrorMessage(e && e.name));
    return;
  }

  // Reset per-recording state. The previous session is already in history, so
  // clearing here cannot lose anything.
  mediaStream = stream;
  transcript  = '';
  chunkSeq    = 0;
  chunkErrors = 0;
  sawSound    = false;
  meterTicks  = 0;
  isRecording = true;
  // Before the record-start persist below, or this session's history entry is
  // written carrying the previous recording's duration.
  timerSeconds = 0;

  // Clear the previous note off the screen before the new session id exists.
  // persistSession() reads the SOAP straight out of the DOM, so a note left
  // showing from the last patient would be saved onto this recording — and it
  // would also simply sit there on screen during someone else's visit. (This
  // bit the save at stop too, not just the new save at start.)
  soapData = null;
  ['soapS', 'soapO', 'soapA', 'soapP'].forEach(id => document.getElementById(id).textContent = '');
  document.getElementById('soapSection').classList.remove('visible');
  document.getElementById('cptRow').classList.remove('visible');
  document.getElementById('safetyWarning').classList.remove('visible');

  // Each recording is its own history entry, dated by when it was recorded.
  currentSessionId = Date.now();
  sessionStartISO  = new Date().toISOString();

  audioMime = pickAudioMime(mimeSupported);
  const opts = { audioBitsPerSecond: AUDIO_BPS };
  if (audioMime) opts.mimeType = audioMime;
  try {
    mediaRecorder = new MediaRecorder(stream, opts);
  } catch (e) {
    // A browser can advertise a type and still refuse the options object —
    // fall back to its own defaults rather than failing the session.
    diag('recorder_opts_rejected', (e && e.name) || 'error');
    try {
      mediaRecorder = new MediaRecorder(stream);
      audioMime = mediaRecorder.mimeType || '';
    } catch (e2) {
      diag('recorder_error', (e2 && e2.name) || 'error');
      showError('Could not start the audio recorder in this browser. Please use Safari, Chrome, or Edge.');
      releaseStream();
      isRecording = false;
      return;
    }
  }
  if (!audioMime) audioMime = mediaRecorder.mimeType || '';

  // The recorder can fail on its own mid-session. Unhandled, it simply stops and
  // says nothing — the interrupted banner would catch it on the next load, but
  // she needs to know now, while the visit is still in the room.
  mediaRecorder.onerror = (e) => {
    const name = (e && e.error && e.error.name) || 'error';
    diag('recorder_failed', name + ' chunks:' + chunkSeq);
    showError('Recording stopped unexpectedly (' + name + '). Everything captured ' +
              'so far is saved — press record to start a new recording for the rest ' +
              'of this visit.');
    if (isRecording) stopRecording();
  };

  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const seq = chunkSeq++;
    const sid = currentSessionId;
    putAudioChunk(sid, seq, e.data, audioMime)
      .then(() => { if (seq === 0) diag('audio_first_chunk', 'bytes:' + e.data.size); })
      .catch((err) => {
        chunkErrors++;
        diag('audio_chunk_error', (err && err.name) || 'error');
        // Repeat, not once: a single banner 40 minutes ago is a banner she never
        // saw. Every 12th failure is about once a minute at a 5s chunk rate.
        if (chunkErrors === 1 || chunkErrors % 12 === 0) {
          showError('This browser is refusing to save audio to disk (storage may be full) — ' +
                    chunkErrors + ' failed write' + (chunkErrors === 1 ? '' : 's') + ' so far. ' +
                    'The session is still recording, but parts of it are NOT being saved. ' +
                    'Finish the visit, then check the recording before relying on it.');
        }
      });
  };

  // A track that ends or mutes on its own means the mic genuinely went away
  // (unplugged, grabbed by another app). That is worth interrupting for.
  stream.getAudioTracks().forEach(track => {
    track.onended = () => {
      if (!isRecording) return;
      diag('track_ended');
      showError('The microphone stopped unexpectedly. Recording has been stopped — the audio up to this point is saved.');
      stopRecording();
    };
    // A track can go silent without ending: the OS hands the mic to something
    // else, or a Bluetooth headset switches profile. Recording carries on happily
    // and produces a full-length file of nothing. Worth interrupting for — but it
    // is recoverable, so the recording deliberately keeps running.
    track.onmute = () => {
      if (!isRecording) return;
      diag('track_muted');
      showError('The microphone has gone silent — another app may have taken it, or a ' +
                'Bluetooth device switched modes. The recording is still running, but ' +
                'nothing is being heard. Check System Settings ▸ Sound ▸ Input.');
    };
    track.onunmute = () => {
      if (!isRecording) return;
      diag('track_unmuted');
      if (document.getElementById('errorMsg').textContent.indexOf('gone silent') !== -1) hideError();
    };
  });

  try {
    mediaRecorder.start(CHUNK_MS);
  } catch (e) {
    diag('recorder_start_error', (e && e.name) || 'error');
    showError('Could not start recording: ' + ((e && e.name) || 'unknown error'));
    releaseStream();
    isRecording = false;
    return;
  }

  // Banked to history now, not at stop. Chunks start landing in IndexedDB
  // immediately, and until a session record names them nothing in the app can
  // reach them — a page death mid-recording used to strand the whole session
  // invisibly (two lost intakes on Aug 31, 2026, one of them 40 minutes).
  // resumeUnfinishedWork() finds this record on the next load and offers it.
  persistSession({ hasAudio: true, audioMime, transcriptionStatus: 'recording' });

  diag('record_start', 'mime:' + (audioMime || 'default'));
  startMeter(stream);

  document.getElementById('recordBtn').classList.add('recording');
  document.getElementById('micIcon').style.display = 'none';
  document.getElementById('stopIcon').style.display = 'block';
  document.getElementById('recordLabel').textContent = 'Recording — tap to stop';
  document.getElementById('statusDot').className = 'status-dot live';
  document.getElementById('ring1').classList.add('active');
  document.getElementById('ring2').classList.add('active');
  document.getElementById('ring3').classList.add('active');
  document.getElementById('waveform').classList.add('active');
  document.getElementById('timer').classList.add('visible');
  document.getElementById('transcriptSection').classList.add('visible');
  document.getElementById('generateBtn').classList.remove('ready');
  setTranscriptPlaceholder('Recording. The transcript is produced after you press stop.');
  setTranscribeStatus('', '');

  // Wall clock, not a tick count. Safari throttles setInterval hard in a
  // backgrounded tab, so incrementing a counter under-reported long sessions
  // badly — one 16.5-minute recording displayed as 8m 21s. That number is
  // stored as the session duration and drives CPT selection, so a throttled
  // timer is a billing error, not just a cosmetic one.
  timerStartedAt = Date.now();
  timerSeconds = 0;
  document.getElementById('timer').textContent = '00:00';
  timerInterval = setInterval(() => {
    timerSeconds = Math.floor((Date.now() - timerStartedAt) / 1000);
    const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
    const s = String(timerSeconds % 60).padStart(2, '0');
    document.getElementById('timer').textContent = m + ':' + s;
    // Keep the stored duration roughly current so that if this recording dies
    // without a stop, the interrupted banner can say how much was captured.
    if (timerSeconds && timerSeconds % 30 === 0 && currentSessionId) {
      updateSession(currentSessionId, { duration: timerSeconds });
    }
  }, 1000);

  // If nothing at all registers on the meter early on, the wrong input device is
  // almost certainly selected. Say so once, then stop nagging.
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(checkSilence, SILENCE_HINT_MS);
}

// `onFinished` runs once the recorder has flushed and the session is safely in
// history — callers that want to reset the screen must wait for that, or they
// would clear `currentSessionId` out from under the final chunk write.
function stopRecording(onFinished) {
  if (!isRecording) return;
  isRecording = false;
  clearInterval(timerInterval);
  // Settle the duration from the clock, not from whatever the last (possibly
  // throttled) tick happened to leave behind.
  if (timerStartedAt) timerSeconds = Math.floor((Date.now() - timerStartedAt) / 1000);
  clearTimeout(silenceTimer);
  stopMeter();

  const finish = () => { releaseStream(); finishRecording(onFinished); };
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = finish;
    try { mediaRecorder.stop(); } catch (e) { finish(); }
  } else {
    finish();
  }

  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('micIcon').style.display = 'block';
  document.getElementById('stopIcon').style.display = 'none';
  document.getElementById('recordLabel').textContent = 'Session ended';
  document.getElementById('statusDot').className = 'status-dot done';
  document.getElementById('ring1').classList.remove('active');
  document.getElementById('ring2').classList.remove('active');
  document.getElementById('ring3').classList.remove('active');
  document.getElementById('waveform').classList.remove('active');
}

// Runs once MediaRecorder has flushed its final chunk: the recording is now
// complete on disk. Persist the session first, then start transcription — in
// that order, so a failure in the second step can never affect the first.
function finishRecording(onFinished) {
  diag('record_stop', 'dur:' + timerSeconds + 's chunks:' + chunkSeq + ' errs:' + chunkErrors);
  if (!chunkSeq) {
    showError('No audio was captured for this session. Check the microphone input and try again.');
    setTranscriptPlaceholder('No audio was captured.');
    if (onFinished) onFinished();
    return;
  }
  persistSession({ hasAudio: true, audioMime, transcriptionStatus: 'queued' });
  pruneAudio();
  transcribeSession(currentSessionId);
  if (onFinished) onFinished();
}

function releaseStream() {
  if (mediaStream) {
    try { mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  }
  mediaStream = null;
  mediaRecorder = null;
}

// ── Level meter ───────────────────────────────────────────────────────────────
//
// Honest proof of capture: the bars are driven by the *same* MediaStream being
// written to disk, so movement means audio is genuinely arriving. (The old
// waveform was a fixed CSS animation that ran whether or not the mic worked.)
// Only `transform` is written — compositor-only, no layout or paint — and
// repaints are gated to ~12fps, so this stays far cheaper than the per-frame
// height mutation that used to spin the fan up.

// Only warn about a silent microphone when silence was actually *measured*.
//
// The meter is driven by requestAnimationFrame off an AnalyserNode, and both can
// stop reporting while the recording is perfectly fine: rAF is paused outright
// in a hidden tab, and a suspended AudioContext returns zeros. Treating "no
// samples" as "no sound" is how a 19-minute session containing 187 turns of real
// conversation got told the mic was dead, 20 seconds in, right as the physician
// switched to her EHR. Absence of evidence is not evidence of silence — so when
// the meter has nothing to say, the check waits and asks again instead.
function checkSilence() {
  if (!isRecording || sawSound) return;

  if (shouldWarnNoSound({
        sawSound, meterTicks, hidden: document.hidden,
        ctxState: audioCtx ? audioCtx.state : null,
      })) {
    diag('no_sound_detected', 'ticks:' + meterTicks);
    showError('No sound is reaching the microphone. Check the input device in ' +
              'System Settings ▸ Sound ▸ Input — the recording is still running.');
    return;   // said once; the meter clears it if sound arrives
  }

  diag('no_sound_check_deferred',
       'ticks:' + meterTicks + ' hidden:' + document.hidden +
       ' ctx:' + (audioCtx ? audioCtx.state : 'none'));
  silenceTimer = setTimeout(checkSilence, SILENCE_HINT_MS);
}

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (e) { return false; }
}

function startMeter(stream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (prefersReducedMotion()) {
    // Still detect sound (for the wrong-input hint) but do not animate.
    sawSound = true;
    return;
  }
  try {
    audioCtx = new Ctx();
    // Safari hands back a suspended context whenever it was not created inside
    // a user gesture — and it never is here, because startRecording() awaits
    // getUserMedia() first, which spends the gesture. A suspended context feeds
    // the analyser nothing but zeros forever, which is indistinguishable from a
    // dead microphone and is how a working recording got flagged "no sound".
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const source = audioCtx.createMediaStreamSource(stream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 64;
    analyserNode.smoothingTimeConstant = 0.75;
    source.connect(analyserNode);
  } catch (e) {
    diag('meter_error', (e && e.name) || 'error');
    sawSound = true;   // cannot measure — do not raise a false "no sound" alarm
    return;
  }

  const bins = new Uint8Array(analyserNode.frequencyBinCount);
  const bars = Array.prototype.slice.call(document.querySelectorAll('#waveform .bar'));
  document.getElementById('waveform').classList.add('metered');
  let last = 0;

  const tick = (now) => {
    if (!isRecording) return;
    meterRAF = requestAnimationFrame(tick);
    if (now - last < METER_MS) return;
    last = now;
    meterTicks++;
    analyserNode.getByteFrequencyData(bins);
    let peak = 0;
    for (let i = 0; i < bars.length; i++) {
      const v = (bins[i + 1] || 0) / 255;
      if (v > peak) peak = v;
      const scale = Math.max(0.12, Math.min(1, v * 1.8));
      bars[i].style.transform = 'scaleY(' + scale.toFixed(2) + ')';
    }
    if (peak > 0.06) {
      sawSound = true;
      if (document.getElementById('errorMsg').textContent.indexOf('No sound is reaching') === 0) hideError();
    }
  };
  meterRAF = requestAnimationFrame(tick);
}

function stopMeter() {
  if (meterRAF) cancelAnimationFrame(meterRAF);
  meterRAF = null;
  const wave = document.getElementById('waveform');
  wave.classList.remove('metered');
  Array.prototype.slice.call(document.querySelectorAll('#waveform .bar'))
    .forEach(b => { b.style.transform = ''; });
  if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
  audioCtx = null;
  analyserNode = null;
}

// ── Transcription (AssemblyAI) ────────────────────────────────────────────────

function assemblyHeaders(extra) {
  return Object.assign({ authorization: assemblyKey }, extra || {});
}

async function assemblyUpload(blob) {
  let res;
  try {
    res = await fetch(ASSEMBLY_BASE + '/v2/upload', {
      method: 'POST',
      headers: assemblyHeaders({ 'content-type': 'application/octet-stream' }),
      body: blob,
    });
  } catch (e) {
    throw new Error(assemblyErrorMessage(0, ''));
  }
  if (!res.ok) throw new Error(assemblyErrorMessage(res.status, await res.text().catch(() => '')));
  const data = await res.json();
  if (!data.upload_url) throw new Error(assemblyErrorMessage(0, 'no upload url returned'));
  return data.upload_url;
}

async function assemblySubmit(audioUrl) {
  let res;
  try {
    res = await fetch(ASSEMBLY_BASE + '/v2/transcript', {
      method: 'POST',
      headers: assemblyHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        audio_url: audioUrl,
        speech_models: ['universal-3-5-pro'],
        domain: 'medical-v1',      // medication / dosage / condition accuracy
        speaker_labels: true,      // who said what → a much better S section
        punctuate: true,
        format_text: true,
        language_code: 'en_us',
      }),
    });
  } catch (e) {
    throw new Error(assemblyErrorMessage(0, ''));
  }
  if (!res.ok) throw new Error(assemblyErrorMessage(res.status, await res.text().catch(() => '')));
  const data = await res.json();
  if (!data.id) throw new Error(assemblyErrorMessage(0, 'no transcript id returned'));
  return data.id;
}

async function assemblyFetch(id) {
  let res;
  try {
    res = await fetch(ASSEMBLY_BASE + '/v2/transcript/' + encodeURIComponent(id), {
      headers: assemblyHeaders(),
    });
  } catch (e) {
    throw new Error(assemblyErrorMessage(0, ''));
  }
  if (!res.ok) throw new Error(assemblyErrorMessage(res.status, await res.text().catch(() => '')));
  return res.json();
}

// Upload → submit → poll. Safe to call for any session id, live or historical.
// Every state change is written to the session record, so closing the tab
// mid-transcription loses nothing: resumeUnfinishedWork() picks it back up.
async function transcribeSession(sessionId, opts) {
  if (inFlight.has(sessionId)) return;
  inFlight.add(sessionId);
  const resuming = !!(opts && opts.resume);

  try {
    hideError();
    updateSession(sessionId, { transcriptionStatus: 'uploading', transcriptionError: null });
    if (isDisplayed(sessionId)) setTranscribeStatus('uploading');

    let assemblyId = resuming ? (findSession(sessionId) || {}).assemblyId : null;

    if (!assemblyId) {
      const blob = await getAudioBlob(sessionId);
      if (!blob || !blob.size) throw new Error('The audio for this session is no longer in this browser, so it cannot be transcribed.');
      diag('upload_start', 'bytes:' + blob.size);
      const uploadUrl = await assemblyUpload(blob);
      assemblyId = await assemblySubmit(uploadUrl);
      updateSession(sessionId, { assemblyId, transcriptionStatus: 'queued' });
      diag('transcribe_submitted');
    }

    if (isDisplayed(sessionId)) setTranscribeStatus('queued');

    const started = Date.now();
    let result = null;
    while (Date.now() - started < POLL_MAX_MS) {
      await sleep(POLL_MS);
      const data = await assemblyFetch(assemblyId);
      if (data.status === 'completed') { result = data; break; }
      if (data.status === 'error') throw new Error('AssemblyAI could not transcribe this audio: ' + (data.error || 'unknown reason'));
      if (data.status !== (findSession(sessionId) || {}).transcriptionStatus) {
        updateSession(sessionId, { transcriptionStatus: data.status });
        if (isDisplayed(sessionId)) setTranscribeStatus(data.status);
      }
    }
    if (!result) throw new Error('Transcription is taking unusually long. The audio is saved — retry from the sidebar.');

    const text = buildUtteranceTranscript(result.utterances, result.text);
    const secs = Math.round(Number(result.audio_duration) || 0);
    recordUsage(secs);

    updateSession(sessionId, {
      transcript: text,
      transcriptionStatus: 'completed',
      transcriptionError: null,
      audioSeconds: secs,
      duration: secs || (findSession(sessionId) || {}).duration,
    });
    diag('transcribe_ok', 'dur:' + secs + 's conf:' + (result.confidence || '?'));

    if (isDisplayed(sessionId)) {
      transcript = text;
      setTranscribeStatus('completed');
      renderTranscript(text);
      checkSafetyDoc();
      document.getElementById('generateBtn').classList.remove('hidden');
      document.getElementById('generateBtn').classList.add('ready');
      document.getElementById('recordLabel').textContent = 'Transcript ready — generate the note';
    }
    renderSidebar();
    renderCredits();

  } catch (err) {
    diag('transcribe_error', String(err && err.message || err).slice(0, 120));
    updateSession(sessionId, { transcriptionStatus: 'error', transcriptionError: String(err && err.message || err) });
    if (isDisplayed(sessionId)) {
      setTranscribeStatus('error');
      showError(String(err && err.message || err));
      showRetry(sessionId);
    }
    renderSidebar();
  } finally {
    inFlight.delete(sessionId);
  }
}

function retryTranscription(sessionId) {
  hideError();
  hideRetry();
  transcribeSession(sessionId);
}

// On load, pick up anything left mid-flight by a closed tab: a session that was
// submitted to AssemblyAI (poll it again — the result is waiting server-side), or
// one that has audio but never got a transcript at all.
function resumeUnfinishedWork() {
  // Interrupted recordings are handled first and separately: they are the only
  // case where the physician may still be able to act on it in the room.
  const interrupted = findInterruptedSessions(sessions);
  if (interrupted.length) showInterruptedBanner(interrupted);

  const pending = sessions.filter(s => needsTranscription(s) && !isInterruptedRecording(s));
  if (!pending.length) return;
  diag('resume_pending', 'count:' + pending.length);
  const banner = document.getElementById('pendingBanner');
  const resumable = pending.filter(s => s.assemblyId);
  // Resume server-side jobs silently — the result is already paid for.
  resumable.slice(0, 3).forEach(s => transcribeSession(s.id, { resume: true }));
  const stalled = pending.filter(s => !s.assemblyId);
  if (stalled.length) {
    document.getElementById('pendingBannerText').textContent =
      stalled.length === 1
        ? 'One recorded session has no transcript yet. Its audio is saved.'
        : stalled.length + ' recorded sessions have no transcript yet. Their audio is saved.';
    banner.dataset.ids = stalled.map(s => s.id).join(',');
    banner.classList.remove('hidden');
  }
}

// Names the time and how much was captured, because "a recording was
// interrupted" is not actionable but "started 1:56 PM, 19 minutes" is.
function showInterruptedBanner(list) {
  diag('resume_interrupted', 'count:' + list.length);
  const banner = document.getElementById('interruptedBanner');
  const el = document.getElementById('interruptedBannerText');

  if (list.length === 1) {
    const s = list[0];
    const started = new Date(s.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const dur = formatDuration(s.duration);
    el.textContent = 'A recording started at ' + started + ' stopped before it was finished' +
      (dur ? ', after ' + dur : '') + '. Everything captured up to that point is saved. ' +
      'If that visit is still going, press record now to capture the rest.';
  } else {
    el.textContent = list.length + ' recordings stopped before they were finished. ' +
      'Everything captured is saved and can be transcribed.';
  }
  banner.dataset.ids = list.map(s => s.id).join(',');
  banner.classList.remove('hidden');
}

function bannerIds(id) {
  const banner = document.getElementById(id);
  const ids = (banner.dataset.ids || '').split(',').filter(Boolean).map(Number);
  banner.classList.add('hidden');
  return ids;
}

function transcribeInterrupted() {
  const ids = bannerIds('interruptedBanner');
  // Leave 'recording' behind first, or these come back as interrupted forever.
  ids.forEach(id => updateSession(id, { transcriptionStatus: 'queued' }));
  renderSidebar();
  ids.forEach(id => transcribeSession(id));
}

function dismissInterrupted() {
  const ids = bannerIds('interruptedBanner');
  // Nothing is deleted — the session just stops claiming to be live. It stays in
  // the sidebar flagged for transcription and can be run whenever.
  ids.forEach(id => updateSession(id, {
    transcriptionStatus: 'error',
    transcriptionError: 'This recording was interrupted before it finished. ' +
      'The audio captured up to that point is saved — transcribe it whenever you like.',
  }));
  renderSidebar();
}

function transcribePending() {
  const banner = document.getElementById('pendingBanner');
  const ids = (banner.dataset.ids || '').split(',').filter(Boolean).map(Number);
  banner.classList.add('hidden');
  ids.forEach(id => transcribeSession(id));
}

// ── Usage / credit estimate ───────────────────────────────────────────────────

function loadUsage() {
  try { return JSON.parse(localStorage.getItem(USAGE_KEY) || '{"seconds":0}'); }
  catch (e) { return { seconds: 0 }; }
}

function recordUsage(seconds) {
  const usage = loadUsage();
  usage.seconds = (Number(usage.seconds) || 0) + (Number(seconds) || 0);
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch (e) {}
}

function renderCredits() {
  const el = document.getElementById('creditMeter');
  if (!el) return;
  const usage  = loadUsage();
  const spent  = estimateCost(usage.seconds);
  const status = creditStatus(spent);
  const hrs    = hoursRemaining(status.remaining);

  el.className = 'credit-meter ' + status.level;
  if (status.level === 'empty') {
    el.textContent = 'AssemblyAI free credits are estimated to be used up — top up at assemblyai.com/app.';
  } else if (status.level === 'low') {
    el.textContent = 'About ' + formatUsd(status.remaining) + ' of AssemblyAI credit left (~' +
                     Math.round(hrs) + ' more hours). Top up soon at assemblyai.com/app.';
  } else {
    el.textContent = 'Estimated AssemblyAI credit: ' + formatUsd(status.remaining) + ' left (~' +
                     Math.round(hrs) + ' hours of recording).';
  }
  el.classList.toggle('hidden', !hasKeys());
}

// ── SOAP generation ──────────────────────────────────────────────────────────

const SOAP_PROMPT = `You are a medical scribe assistant for a psychiatrist. Below is a transcript from a patient session. Convert it into a structured SOAP note.

The transcript is diarized: each line is prefixed with a speaker label such as "Speaker A:". The labels are anonymous — infer from context which speaker is the clinician and which is the patient (the clinician typically asks the questions, and discusses medication and plan). Use that separation: what the patient says belongs in S, what the clinician observes or decides belongs in O/A/P. Never attribute a statement to the wrong party.

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

Be concise but clinically complete. Use proper psychiatric terminology. Do not add information not present in the transcript. Transcription is automated and may contain errors — if a medication name or dosage is garbled, write it as heard rather than guessing a plausible substitute.

TRANSCRIPT:
{{transcript}}

Respond with only the JSON object, no markdown, no explanation.`;

// An error whose message is already written for the physician — shown verbatim,
// with no raw API text bolted onto it.
function friendlyError(message) {
  const err = new Error(message);
  err.friendly = true;
  return err;
}

async function generateSOAP() {
  const viewing = viewMode ? findSession(viewingSessionId) : null;
  const sourceText = viewing ? (viewing.transcript || '') : transcript;
  if (isRecording) { stopRecording(); return; }
  if (!sourceText.trim()) {
    showError('There is no transcript for this session yet, so there is nothing to write a note from. ' +
      'If the recording is still transcribing, wait for it to finish; if transcription failed, ' +
      'the audio is saved — reopen the session from the sidebar and use "Transcribe from saved audio".');
    return;
  }

  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating...';
  hideError();
  diag('generate_start', 'transcriptLen:' + sourceText.length);

  try {
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 8000,
          messages: [{ role: 'user', content: SOAP_PROMPT.replace('{{transcript}}', sourceText) }]
        })
      });
    } catch (netErr) {
      throw friendlyError(noteErrorMessage(0, String((netErr && netErr.message) || '')));
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      diag('generate_http', 'status:' + response.status);
      throw friendlyError(noteErrorMessage(response.status, bodyText));
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    let parsed;
    try {
      parsed = parseSOAPResponse(textBlock ? textBlock.text : '');
    } catch (parseErr) {
      throw friendlyError('The transcript is saved. Claude returned a note that could not be read ' +
        '(malformed JSON) — generate again, which almost always fixes it.');
    }

    document.getElementById('soapS').textContent = parsed.S || '—';
    document.getElementById('soapO').textContent = parsed.O || '—';
    document.getElementById('soapA').textContent = parsed.A || '—';
    document.getElementById('soapP').textContent = parsed.P || '—';

    if (viewing) {
      viewing.soap = readSoapFromDOM();
      viewing.updatedAt = Date.now();
      saveSessions();
      ['soapS', 'soapO', 'soapA', 'soapP'].forEach(id => document.getElementById(id).removeAttribute('contenteditable'));
      renderSidebar();
      const item = document.querySelector('.session-item[data-id="' + viewing.id + '"]');
      if (item) item.classList.add('active');
      document.getElementById('generateBtn').classList.add('hidden');
    } else {
      soapData = parsed;
      persistSession();
      document.getElementById('statusDot').className = 'status-dot done';
      document.getElementById('recordBtn').disabled = true;
      document.getElementById('recordLabel').textContent = 'Note generated and saved — click New Session to continue';
    }

    showCPT(viewing ? viewing.duration : timerSeconds);
    document.getElementById('soapSection').classList.add('visible');
    document.getElementById('soapSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    pruneAudio();
    diag('generate_ok');

  } catch (err) {
    diag('generate_error', err.message);
    showError(err && err.friendly
      ? err.message
      : 'The transcript is saved in the session list — generating the note failed (' +
        String((err && err.message) || err) + '), so retry now or later; nothing is lost.');
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

function showCPT(seconds) {
  const pairs = selectCPT(seconds);
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

function findSession(id) { return sessions.find(s => s.id === id) || null; }

// A write is a merge, never a blind overwrite — see mergeSessions() for why.
// Returns false only when the write itself failed.
function saveSessions() {
  let onDisk = [];
  try { onDisk = JSON.parse(localStorage.getItem('scribe_sessions') || '[]'); } catch (e) {}
  sessions = mergeSessions(sessions, onDisk, 100);
  try {
    localStorage.setItem('scribe_sessions', JSON.stringify(sessions));
    storageFullWarned = false;
    return true;
  } catch (e) {
    diag('persist_error', (e && e.name) || 'error');
    warnStorageFull();
    return false;
  }
}

// A failed write used to be swallowed: the transcript was on screen and simply
// never saved. Nothing about that is visible, so it has to shout.
let storageFullWarned = false;
function warnStorageFull() {
  if (storageFullWarned) return;
  storageFullWarned = true;
  showError('This browser will not save any more sessions — its storage is full. ' +
            'The audio for this session is still on disk, but the transcript and note ' +
            'are NOT being saved. Copy anything you need now, then open the recovery ' +
            'page to save recordings off this machine.');
}

// Another tab wrote the session list. Take its version, merged with ours, so the
// two copies converge instead of one silently winning.
window.addEventListener('storage', (e) => {
  if (e.key !== 'scribe_sessions') return;
  let theirs = [];
  try { theirs = JSON.parse(e.newValue || '[]'); } catch (err) { return; }
  sessions = mergeSessions(sessions, theirs, 100);
  diag('sessions_merged_from_tab', 'count:' + sessions.length);
  renderSidebar();
});

// Patch fields onto a stored session without disturbing the rest of it.
function updateSession(id, patch) {
  const s = findSession(id);
  if (!s) return null;
  Object.assign(s, patch);
  s.updatedAt = Date.now();   // mergeSessions() resolves conflicts by this
  saveSessions();
  return s;
}

// Is this session the one currently on screen (live or being viewed)?
function isDisplayed(id) {
  return viewMode ? viewingSessionId === id : currentSessionId === id;
}

function formatDuration(s) {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

function renderSessionItem(s) {
  const d       = new Date(s.date);
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const preview = s.transcript
    ? s.transcript.slice(0, 50).trim().replace(/</g, '&lt;') + (s.transcript.length > 50 ? '…' : '')
    : (s.hasAudio ? 'Audio saved — no transcript yet' : 'No transcript');
  const dur = formatDuration(s.duration);

  let flag = '';
  if (isInterruptedRecording(s)) {
    flag = '<span class="session-item-flag err">Interrupted</span>';
  } else if (needsTranscription(s)) {
    if (s.transcriptionStatus === 'error') {
      flag = '<span class="session-item-flag err">Needs transcript</span>';
    } else {
      flag = '<span class="session-item-flag">' +
             (transcriptionLabel(s.transcriptionStatus) || 'Transcribing…') + '</span>';
    }
  } else if (!sessionHasNote(s)) {
    flag = '<span class="session-item-flag">No note yet</span>';
  }

  return `<div class="session-item" data-id="${s.id}" onclick="viewSession(${s.id})">
    <div class="session-item-meta">
      <span class="session-item-date">${timeStr}</span>
      <span>${flag}${dur ? `<span class="session-item-dur">${dur}</span>` : ''}</span>
    </div>
    <div class="session-item-preview">${preview}</div>
  </div>`;
}

function renderSidebar() {
  const list = document.getElementById('sessionList');
  if (!sessions.length) {
    list.innerHTML = '<div class="session-empty">Sessions save here automatically when you stop recording</div>';
    return;
  }

  const groups = groupSessionsByDay(sessions);

  // Open the most recent day on first render — that is almost always the day
  // being worked on. Everything older stays folded until asked for.
  if (!openDaysSeeded) {
    if (groups.length) openDays.add(groups[0].key);
    openDaysSeeded = true;
  }
  // Never hide the session currently on screen inside a closed folder.
  if (viewMode && viewingSessionId) {
    const active = findSession(viewingSessionId);
    if (active) openDays.add(dayKey(active.date));
  }

  list.innerHTML = groups.map(g => {
    const open  = openDays.has(g.key);
    const needs = g.sessions.filter(s => isInterruptedRecording(s) || needsTranscription(s)).length;
    const badge = needs && !open
      ? `<span class="session-day-badge" title="${needs} need attention">${needs}</span>` : '';
    return `<div class="session-day">
      <button class="session-day-header${open ? ' open' : ''}" onclick="toggleDay('${g.key}')"
              aria-expanded="${open}">
        <span class="session-day-chevron" aria-hidden="true">›</span>
        <span class="session-day-label">${dayLabel(g.date)}</span>
        ${badge}<span class="session-day-count">${g.sessions.length}</span>
      </button>
      ${open ? `<div class="session-day-items">${g.sessions.map(renderSessionItem).join('')}</div>` : ''}
    </div>`;
  }).join('');
}

function toggleDay(key) {
  if (openDays.has(key)) openDays.delete(key);
  else openDays.add(key);
  renderSidebar();
  // Re-mark the active item; renderSidebar rebuilds the list from scratch.
  if (viewMode && viewingSessionId) {
    const item = document.querySelector('.session-item[data-id="' + viewingSessionId + '"]');
    if (item) item.classList.add('active');
  }
}

// The SOAP note as currently shown/edited on screen, or null if there isn't one.
function readSoapFromDOM() {
  const S = document.getElementById('soapS').textContent;
  const O = document.getElementById('soapO').textContent;
  const A = document.getElementById('soapA').textContent;
  const P = document.getElementById('soapP').textContent;
  return [S, O, A, P].some(t => t.trim() && t.trim() !== '—') ? { S, O, A, P } : null;
}

// Upsert the in-progress session into permanent history. Runs at stop (with the
// audio flags), after transcription, after note generation, and at New Session
// (captures SOAP edits). `extra` merges additional fields for this write.
function persistSession(extra) {
  const soap = readSoapFromDOM();
  const hasAudio = !!(extra && extra.hasAudio) || !!(findSession(currentSessionId) || {}).hasAudio;
  if (!transcript.trim() && !soap && !hasAudio) return false;
  if (!currentSessionId) currentSessionId = Date.now();
  if (!sessionStartISO)  sessionStartISO  = new Date().toISOString();

  const existing = findSession(currentSessionId) || {};
  const session = Object.assign({}, existing, {
    id:         currentSessionId,
    date:       sessionStartISO,
    // Prefer AssemblyAI's measured audio length once we have it — it is what was
    // actually billed, and what the CPT tier should be judged on.
    duration:   existing.audioSeconds || timerSeconds || existing.duration || 0,
    transcript: transcript || existing.transcript || '',
    soap:       soap || existing.soap || null,
    updatedAt:  Date.now(),
  }, extra || {});

  sessions = upsertSession(sessions, session, 100);
  if (!saveSessions()) return false;
  renderSidebar();
  diag('session_persisted', 'len:' + session.transcript.length + (session.soap ? ' soap:yes' : ' soap:no'));
  return true;
}

function viewSession(id) {
  const session = findSession(id);
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

  viewingSessionId = id;
  viewMode = true;
  if (isRecording) stopRecording();

  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  const item = document.querySelector('.session-item[data-id="' + id + '"]');
  if (item) item.classList.add('active');

  const d = new Date(session.date);
  document.getElementById('viewingBannerDate').textContent =
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  document.getElementById('viewingBanner').classList.remove('hidden');
  document.getElementById('recordSection').classList.add('hidden');
  document.getElementById('transcriptSection').classList.add('visible');
  document.getElementById('safetyWarning').classList.remove('visible');
  document.querySelector('.new-session-btn').classList.add('hidden');
  document.getElementById('cptRow').classList.remove('visible');
  hideError();
  hideRetry();

  if (needsTranscription(session)) {
    // Audio on disk, no transcript — offer to run (or re-run) transcription.
    renderTranscript('');
    setTranscriptPlaceholder('Audio is saved for this session but it has not been transcribed yet.');
    setTranscribeStatus(inFlight.has(id) ? (session.transcriptionStatus || 'queued') : 'error');
    if (!inFlight.has(id)) {
      if (session.transcriptionError) showError(session.transcriptionError);
      showRetry(id);
    }
    document.getElementById('soapSection').classList.remove('visible');
    document.getElementById('generateBtn').classList.add('hidden');
  } else {
    setTranscribeStatus('');
    renderTranscript(session.transcript || '');
    if (!(session.transcript || '').trim()) setTranscriptPlaceholder('No transcript for this session.');

    if (sessionHasNote(session)) {
      document.getElementById('soapS').textContent = session.soap.S || '—';
      document.getElementById('soapO').textContent = session.soap.O || '—';
      document.getElementById('soapA').textContent = session.soap.A || '—';
      document.getElementById('soapP').textContent = session.soap.P || '—';
      ['soapS', 'soapO', 'soapA', 'soapP'].forEach(x => document.getElementById(x).removeAttribute('contenteditable'));
      document.getElementById('soapSection').classList.add('visible');
      document.getElementById('generateBtn').classList.add('hidden');
    } else {
      document.getElementById('soapSection').classList.remove('visible');
      const gen = document.getElementById('generateBtn');
      gen.classList.remove('hidden');
      gen.classList.add('ready');
    }
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function exitViewMode() {
  if (!viewMode) return;
  viewMode = false;
  viewingSessionId = null;

  document.getElementById('viewingBanner').classList.add('hidden');
  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  ['soapS', 'soapO', 'soapA', 'soapP'].forEach(id => document.getElementById(id).setAttribute('contenteditable', 'true'));
  document.getElementById('recordSection').classList.remove('hidden');
  document.getElementById('generateBtn').classList.remove('hidden');
  document.querySelector('.new-session-btn').classList.remove('hidden');
  hideRetry();
  setTranscribeStatus('');

  if (!viewSnapshot) return;
  const snap = viewSnapshot;
  viewSnapshot = null;

  transcript = snap.transcript;
  renderTranscript(snap.transcript || '');
  if (!snap.transcript) setTranscriptPlaceholder('Transcript will appear here after the session ends.');

  snap.transcriptVisible
    ? document.getElementById('transcriptSection').classList.add('visible')
    : document.getElementById('transcriptSection').classList.remove('visible');

  // Always restore the field contents (not just visibility) so the viewed
  // session's note can never linger in the hidden fields and get persisted
  // as if it belonged to the live session.
  document.getElementById('soapS').textContent = snap.soapS;
  document.getElementById('soapO').textContent = snap.soapO;
  document.getElementById('soapA').textContent = snap.soapA;
  document.getElementById('soapP').textContent = snap.soapP;
  snap.soapVisible
    ? document.getElementById('soapSection').classList.add('visible')
    : document.getElementById('soapSection').classList.remove('visible');

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

// ── Legacy draft recovery ─────────────────────────────────────────────────────
//
// Nothing writes `scribe_draft` any more — the audio file is the recovery copy.
// This only rescues a draft left behind by the previous (Web Speech) build.

function maybeOfferRestore() {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { draft = null; }
  if (!isDraftRestorable(draft)) return;
  pendingDraft = draft;
  const when = draft.savedAt ? new Date(draft.savedAt) : null;
  document.getElementById('restoreBannerText').textContent =
    'Recovered an unsaved transcript from the previous version' +
    (when ? ', saved ' + when.toLocaleString() : '') + '. Restore it?';
  document.getElementById('restoreBanner').classList.remove('hidden');
}

function restoreDraft() {
  if (!pendingDraft) return;
  transcript   = pendingDraft.transcript || '';
  timerSeconds = pendingDraft.duration || 0;
  currentSessionId = Date.now();
  sessionStartISO  = pendingDraft.savedAt || new Date().toISOString();
  pendingDraft = null;
  persistSession();
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}

  const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
  const s = String(timerSeconds % 60).padStart(2, '0');
  document.getElementById('timer').textContent = m + ':' + s;
  document.getElementById('timer').classList.add('visible');
  renderTranscript(transcript);
  document.getElementById('transcriptSection').classList.add('visible');
  document.getElementById('generateBtn').classList.add('ready');
  document.getElementById('recordLabel').textContent = 'Recovered — review, then Generate SOAP Note';
  checkSafetyDoc();
  diag('draft_restored');
  hideRestore();
}

function discardDraft() {
  pendingDraft = null;
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  hideRestore();
}

function hideRestore() {
  document.getElementById('restoreBanner').classList.add('hidden');
}

// ── Session reset ─────────────────────────────────────────────────────────────

// Clears the screen for the next patient. Safe to click at any time: nothing is
// discarded, because the session is already in history.
function newSession() {
  // Forgot to press stop? Finish the recording properly first — it lands in
  // history and keeps transcribing in the background under its own entry — and
  // only then clear the screen. Resetting first would orphan the final chunk.
  if (isRecording) { stopRecording(resetSessionScreen); return; }
  resetSessionScreen();
}

function resetSessionScreen() {
  exitViewMode();
  persistSession();

  transcript = '';
  soapData   = null;
  timerSeconds = 0;
  currentSessionId = null;
  sessionStartISO  = null;

  document.getElementById('timer').textContent = '00:00';
  document.getElementById('timer').classList.remove('visible');
  document.getElementById('transcriptSection').classList.remove('visible');
  document.getElementById('soapSection').classList.remove('visible');
  ['soapS', 'soapO', 'soapA', 'soapP'].forEach(id => document.getElementById(id).textContent = '');
  document.getElementById('cptRow').classList.remove('visible');
  document.getElementById('safetyWarning').classList.remove('visible');
  document.getElementById('generateBtn').classList.remove('ready');
  document.getElementById('generateBtn').classList.remove('hidden');
  document.getElementById('recordBtn').disabled = false;
  document.getElementById('recordLabel').textContent = 'Tap to begin session';
  document.getElementById('statusDot').className = 'status-dot';
  renderTranscript('');
  setTranscriptPlaceholder('Transcript will appear here after the session ends.');
  setTranscribeStatus('');
  hideError();
  hideRetry();
  pruneAudio();
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function renderTranscript(text) {
  const box = document.getElementById('transcriptText');
  box.textContent = text || '';
  document.getElementById('transcriptPlaceholder').style.display = (text || '').trim() ? 'none' : '';
  updateTranscriptToggle(text || '');
}

// The transcript box is capped and scrolls internally; this shows how much is in
// there and offers to open it in full. A short transcript needs neither, so the
// control only appears once there is actually something to collapse.
function updateTranscriptToggle(text) {
  const btn = document.getElementById('transcriptToggle');
  const boxEl = document.getElementById('transcriptBox');
  if (!btn || !boxEl) return;

  const words = countWords(text);
  if (!words) {
    btn.classList.add('hidden');
    boxEl.classList.remove('expanded');
    return;
  }
  btn.classList.remove('hidden');
  const expanded = boxEl.classList.contains('expanded');
  btn.textContent = words.toLocaleString() + ' words · ' + (expanded ? 'Collapse' : 'Expand');
}

function toggleTranscript() {
  const boxEl = document.getElementById('transcriptBox');
  boxEl.classList.toggle('expanded');
  if (!boxEl.classList.contains('expanded')) boxEl.scrollTop = 0;
  updateTranscriptToggle(document.getElementById('transcriptText').textContent);
}

function setTranscriptPlaceholder(msg) {
  const el = document.getElementById('transcriptPlaceholder');
  el.textContent = msg;
  el.style.display = document.getElementById('transcriptText').textContent.trim() ? 'none' : '';
}

function setTranscribeStatus(status) {
  const el = document.getElementById('transcribeStatus');
  const label = transcriptionLabel(status);
  if (!label || status === 'completed') {
    el.classList.remove('visible');
    el.innerHTML = '';
    return;
  }
  const spinner = (status === 'error') ? '' : '<span class="spinner sm"></span> ';
  el.innerHTML = spinner + '<span>' + label + '</span>';
  el.className = 'transcribe-status visible' + (status === 'error' ? ' err' : '');
}

function showRetry(sessionId) {
  const btn = document.getElementById('retryBtn');
  btn.classList.remove('hidden');
  btn.onclick = () => retryTranscription(sessionId);
}

function hideRetry() {
  document.getElementById('retryBtn').classList.add('hidden');
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.add('visible');
  const diagBtn = document.getElementById('copyDiagBtn');
  if (diagBtn) diagBtn.classList.remove('hidden');
}

function hideError() {
  const el = document.getElementById('errorMsg');
  el.classList.remove('visible');
  el.textContent = '';
  const diagBtn = document.getElementById('copyDiagBtn');
  if (diagBtn) diagBtn.classList.add('hidden');
}


// ── Init ─────────────────────────────────────────────────────────────────────
//
// Deliberately the LAST thing in this file. index.html loads app.js at the end
// of <body>, so the DOM is ready either way — but running init from the middle
// of the file meant any `const`/`let` declared below it was still in its
// temporal dead zone when init touched it. That trap cost a 40-minute intake
// (`sleep`) and then immediately caught the sidebar's `openDays` too. Keeping
// init at the bottom makes the whole class of bug impossible: every declaration
// in this file is initialized before a single line of it runs.

try { diagLog = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]'); } catch (e) { diagLog = []; }
diag('app_load', 'mime:' + (pickAudioMime(mimeSupported) || 'default'));

if (hasKeys()) {
  showMain();
  maybeOfferRestore();
  resumeUnfinishedWork();
} else {
  prefillSetup();
}
renderSidebar();
renderCredits();
