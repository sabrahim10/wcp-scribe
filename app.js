// ── State ────────────────────────────────────────────────────────────────────

let apiKey      = localStorage.getItem('scribe_key') || '';
let recognition = null;
let isRecording = false;
let transcript  = '';
let timerInterval = null;
let timerSeconds  = 0;
let waveInterval  = null;
let soapData    = null;
let sessions    = JSON.parse(localStorage.getItem('scribe_sessions') || '[]');
let viewMode    = false;
let viewSnapshot = null;

// ── Init ─────────────────────────────────────────────────────────────────────

if (apiKey) {
  document.getElementById('setupCard').classList.add('hidden');
  document.getElementById('mainInterface').classList.remove('hidden');
}
renderSidebar();

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

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  let finalTranscript = '';

  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTranscript += t + ' ';
      else interim = t;
    }
    transcript = finalTranscript + interim;
    updateTranscriptDisplay(transcript);
    document.getElementById('generateBtn').classList.add('ready');
  };

  recognition.onerror = (e) => {
    if (e.error !== 'no-speech') showError('Microphone error: ' + e.error);
  };

  recognition.start();
  isRecording = true;

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

  const bars = document.querySelectorAll('.bar');
  waveInterval = setInterval(() => {
    bars.forEach(b => { b.style.height = (Math.random() * 22 + 4) + 'px'; });
  }, 100);
}

function stopRecording() {
  if (recognition) recognition.stop();
  isRecording = false;
  clearInterval(timerInterval);
  clearInterval(waveInterval);

  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('micIcon').style.display = 'block';
  document.getElementById('stopIcon').style.display = 'none';
  document.getElementById('recordLabel').textContent = 'Session ended';
  document.getElementById('statusDot').className = 'status-dot done';
  document.getElementById('ring1').classList.remove('active');
  document.getElementById('ring2').classList.remove('active');
  document.getElementById('ring3').classList.remove('active');
  document.getElementById('waveform').classList.remove('active');
  document.querySelectorAll('.bar').forEach(b => b.style.height = '4px');
  document.getElementById('transcriptCursor').classList.add('hidden');

  checkSafetyDoc();
}

function updateTranscriptDisplay(text) {
  if (text.trim()) {
    document.getElementById('transcriptPlaceholder').style.display = 'none';
    document.getElementById('transcriptText').textContent = text;
  }
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
        max_tokens: 1500,
        messages: [{ role: 'user', content: SOAP_PROMPT.replace('{{transcript}}', transcript) }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'API error ' + response.status);
    }

    const data = await response.json();
    const raw  = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);

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

  } catch (err) {
    showError('Error generating note: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Generate SOAP Note';
    btn.classList.add('ready');
  }
}

// ── Safety & CPT ─────────────────────────────────────────────────────────────

const SAFETY_TERMS = [
  'suicid', 'self-harm', 'self harm', 'homicid', 'ideation',
  'hurt himself', 'hurt herself', 'hurt themselves',
  'kill himself', 'kill herself',
  'harm to self', 'harm to others',
  ' si ', ' hi ', 'si/hi', 'no si', 'denies si'
];

function checkSafetyDoc() {
  const lower = transcript.toLowerCase();
  const found = SAFETY_TERMS.some(t => lower.includes(t));
  const el = document.getElementById('safetyWarning');
  if (!found && transcript.trim().length > 30) el.classList.add('visible');
  else el.classList.remove('visible');
}

function showCPT() {
  if (timerSeconds === 0) return;
  const min = Math.floor(timerSeconds / 60);
  let pairs;
  if      (min < 16) pairs = [['99212', 'Brief E&M']];
  else if (min < 38) pairs = [['90832', '30 min therapy'], ['99213', 'Med management']];
  else if (min < 53) pairs = [['90834', '45 min therapy'], ['99214', 'Med management']];
  else               pairs = [['90837', '60 min therapy'], ['99215', 'Med management']];

  const COPY_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
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
  if (sessions.length > 50) sessions = sessions.slice(0, 50);
  localStorage.setItem('scribe_sessions', JSON.stringify(sessions));
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
}

function hideError() {
  document.getElementById('errorMsg').classList.remove('visible');
}
