// Shared test spec — a plain list of {name, fn} cases with self-contained
// assertions (each fn throws on failure). Runs identically in two places:
//   - Node:    tests/scribe.test.js wraps each case in node:test
//   - Browser: tests/harness.html runs each case and shows pass/fail (lets us
//              confirm the logic behaves in Safari specifically)
//
// H is the helpers module: require('../helpers.js') in Node, or window in the
// browser (where helpers.js has defined the functions as globals).

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('../helpers.js'));
  } else {
    root.SCRIBE_SPEC = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function (H) {

  // ── tiny assertion helpers (throw on failure) ────────────────────────────────
  const j = (v) => JSON.stringify(v);
  function eq(a, b, msg) {
    if (a !== b) throw new Error(msg || ('expected ' + j(b) + ', got ' + j(a)));
  }
  function deepEq(a, b, msg) {
    if (j(a) !== j(b)) throw new Error(msg || ('expected ' + j(b) + ', got ' + j(a)));
  }
  function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy, got ' + j(v)); }
  function near(a, b, tol, msg) {
    if (Math.abs(a - b) > (tol == null ? 1e-9 : tol)) {
      throw new Error(msg || ('expected ~' + b + ', got ' + a));
    }
  }
  function throws(fn, msg) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) throw new Error(msg || 'expected function to throw');
  }

  const cases = [];
  const test = (name, fn) => cases.push({ name, fn });

  // ── CPT selection ────────────────────────────────────────────────────────────

  test('selectCPT: none before any time elapsed', () => deepEq(H.selectCPT(0), []));
  test('selectCPT: <16 min → brief E&M', () => deepEq(H.selectCPT(10 * 60), [['99212', 'Brief E&M']]));
  test('selectCPT: 30-min tier', () => deepEq(H.selectCPT(25 * 60), [['90832', '30 min therapy'], ['99213', 'Med management']]));
  test('selectCPT: 45-min tier', () => deepEq(H.selectCPT(45 * 60), [['90834', '45 min therapy'], ['99214', 'Med management']]));
  test('selectCPT: 60-min intake tier', () => deepEq(H.selectCPT(60 * 60), [['90837', '60 min therapy'], ['99215', 'Med management']]));
  test('selectCPT: tier boundaries', () => {
    eq(H.selectCPT(15 * 60)[0][0], '99212');
    eq(H.selectCPT(16 * 60)[0][0], '90832');
    eq(H.selectCPT(37 * 60)[0][0], '90832');
    eq(H.selectCPT(38 * 60)[0][0], '90834');
    eq(H.selectCPT(52 * 60)[0][0], '90834');
    eq(H.selectCPT(53 * 60)[0][0], '90837');
  });

  // ── Safety documentation ─────────────────────────────────────────────────────

  test('hasSafetyDoc: detects risk language', () => {
    ok(H.hasSafetyDoc('Patient reports suicidal ideation'));
    ok(H.hasSafetyDoc('denies SI and HI'));
    ok(H.hasSafetyDoc('no homicidal thoughts'));
  });
  test('hasSafetyDoc: false when never addressed', () => eq(H.hasSafetyDoc('Patient slept well and mood is stable.'), false));
  test('hasSafetyDoc: case-insensitive and null-safe', () => {
    ok(H.hasSafetyDoc('SUICIDAL'));
    eq(H.hasSafetyDoc(''), false);
    eq(H.hasSafetyDoc(null), false);
    eq(H.hasSafetyDoc(undefined), false);
  });

  // ── Audio format negotiation ─────────────────────────────────────────────────

  test('pickAudioMime: prefers Opus where it is supported (Chrome)', () => {
    const chrome = (t) => t.indexOf('webm') !== -1;
    eq(H.pickAudioMime(chrome), 'audio/webm;codecs=opus');
  });
  test('pickAudioMime: falls back to MP4 in Safari (rejects every WebM type)', () => {
    const safari = (t) => t.indexOf('mp4') !== -1;
    eq(H.pickAudioMime(safari), 'audio/mp4;codecs=mp4a.40.2');
  });
  test('pickAudioMime: empty string when nothing is supported', () => {
    eq(H.pickAudioMime(() => false), '');
  });
  test('pickAudioMime: a throwing isTypeSupported does not propagate', () => {
    eq(H.pickAudioMime(() => { throw new Error('nope'); }), '');
  });
  test('pickAudioMime: tolerates a missing detector', () => {
    eq(H.pickAudioMime(undefined), '');
    eq(H.pickAudioMime(null), '');
  });

  // ── Microphone error mapping ─────────────────────────────────────────────────

  test('micErrorMessage: permission denial points at the site setting', () => {
    ok(H.micErrorMessage('NotAllowedError').indexOf('Microphone access was blocked') === 0);
    ok(H.micErrorMessage('SecurityError').toLowerCase().indexOf('microphone') !== -1);
  });
  test('micErrorMessage: missing / busy devices get distinct guidance', () => {
    ok(H.micErrorMessage('NotFoundError').indexOf('No microphone was found') === 0);
    ok(H.micErrorMessage('NotReadableError').indexOf('another app') !== -1);
  });
  test('micErrorMessage: unknown name falls back to the raw name', () => {
    ok(H.micErrorMessage('WeirdError').indexOf('WeirdError') !== -1);
    ok(H.micErrorMessage(undefined).indexOf('unknown error') !== -1);
  });

  // ── Speaker-labeled transcript assembly ──────────────────────────────────────

  test('buildUtteranceTranscript: labels each speaker turn', () => {
    const out = H.buildUtteranceTranscript([
      { speaker: 'A', text: 'How have you been sleeping?' },
      { speaker: 'B', text: 'About four hours a night.' },
    ], 'flat fallback');
    eq(out, 'Speaker A: How have you been sleeping?\nSpeaker B: About four hours a night.');
  });

  test('buildUtteranceTranscript: merges consecutive turns by one speaker', () => {
    const out = H.buildUtteranceTranscript([
      { speaker: 'B', text: 'I stopped the sertraline.' },
      { speaker: 'B', text: 'It was making me nauseous.' },
      { speaker: 'A', text: 'When did you stop?' },
    ], '');
    eq(out, 'Speaker B: I stopped the sertraline. It was making me nauseous.\nSpeaker A: When did you stop?');
  });

  test('buildUtteranceTranscript: falls back to flat text when diarization is empty', () => {
    eq(H.buildUtteranceTranscript([], 'the flat transcript'), 'the flat transcript');
    eq(H.buildUtteranceTranscript(null, 'the flat transcript'), 'the flat transcript');
    eq(H.buildUtteranceTranscript(undefined, '  padded  '), 'padded');
  });

  test('buildUtteranceTranscript: skips blank utterances, keeps the rest', () => {
    const out = H.buildUtteranceTranscript([
      { speaker: 'A', text: 'Real line.' },
      { speaker: 'B', text: '   ' },
      { speaker: 'B', text: 'Another real line.' },
    ], '');
    eq(out, 'Speaker A: Real line.\nSpeaker B: Another real line.');
  });

  test('buildUtteranceTranscript: a missing speaker id does not lose the text', () => {
    const out = H.buildUtteranceTranscript([{ text: 'unattributed words' }], '');
    ok(out.indexOf('unattributed words') !== -1);
  });

  test('buildUtteranceTranscript: all-blank utterances fall back rather than return empty', () => {
    eq(H.buildUtteranceTranscript([{ speaker: 'A', text: '  ' }], 'fallback text'), 'fallback text');
  });

  // ── Microphone silence warning ───────────────────────────────────────────────

  test('shouldWarnNoSound: warns only on measured silence', () => {
    ok(H.shouldWarnNoSound({ sawSound: false, meterTicks: 200, hidden: false, ctxState: 'running' }));
  });
  test('shouldWarnNoSound: never warns once sound has been heard', () => {
    ok(!H.shouldWarnNoSound({ sawSound: true, meterTicks: 200, hidden: false, ctxState: 'running' }));
  });
  test('shouldWarnNoSound: a hidden tab pauses rAF — silence cannot be known', () => {
    // The Aug 31 false alarm: recording fine, physician switched to her EHR.
    ok(!H.shouldWarnNoSound({ sawSound: false, meterTicks: 40, hidden: true, ctxState: 'running' }));
  });
  test('shouldWarnNoSound: a meter that never sampled proves nothing', () => {
    ok(!H.shouldWarnNoSound({ sawSound: false, meterTicks: 0, hidden: false, ctxState: 'running' }));
  });
  test('shouldWarnNoSound: a suspended AudioContext only ever reports zeros', () => {
    ok(!H.shouldWarnNoSound({ sawSound: false, meterTicks: 5, hidden: false, ctxState: 'suspended' }));
    ok(!H.shouldWarnNoSound({ sawSound: false, meterTicks: 5, hidden: false, ctxState: 'closed' }));
  });
  test('shouldWarnNoSound: missing state is never a reason to warn', () => {
    ok(!H.shouldWarnNoSound({}));
    ok(!H.shouldWarnNoSound(null));
    ok(!H.shouldWarnNoSound(undefined));
  });

  // ── Multi-tab session merge ──────────────────────────────────────────────────

  test('mergeSessions: a session only the other tab has is kept', () => {
    const mine   = [{ id: 1, date: '2026-08-31T10:00:00Z', updatedAt: 100 }];
    const theirs = [{ id: 2, date: '2026-08-31T11:00:00Z', updatedAt: 100 }];
    const out = H.mergeSessions(mine, theirs, 100);
    eq(out.length, 2);
    // This is the whole point: a blind overwrite used to drop the other tab's work.
    ok(out.some(s => s.id === 2));
  });
  test('mergeSessions: the most recently written copy of an id wins', () => {
    const mine   = [{ id: 1, date: '2026-08-31T10:00:00Z', updatedAt: 100, transcript: 'stale' }];
    const theirs = [{ id: 1, date: '2026-08-31T10:00:00Z', updatedAt: 999, transcript: 'fresh' }];
    eq(H.mergeSessions(mine, theirs, 100)[0].transcript, 'fresh');
    eq(H.mergeSessions(theirs, mine, 100)[0].transcript, 'fresh');
  });
  test('mergeSessions: a stamped record beats a legacy one with no timestamp', () => {
    const legacy  = [{ id: 1, date: '2026-08-31T10:00:00Z', transcript: 'old copy' }];
    const stamped = [{ id: 1, date: '2026-08-31T10:00:00Z', updatedAt: 5, transcript: 'new copy' }];
    eq(H.mergeSessions(legacy, stamped, 100)[0].transcript, 'new copy');
  });
  test('mergeSessions: between two legacy records, the one carrying more wins', () => {
    const thin  = [{ id: 1, date: '2026-08-31T10:00:00Z', transcript: '' }];
    const rich  = [{ id: 1, date: '2026-08-31T10:00:00Z', transcript: 'a real transcript', soap: { S: 'x' } }];
    eq(H.mergeSessions(thin, rich, 100)[0].transcript, 'a real transcript');
    eq(H.mergeSessions(rich, thin, 100)[0].transcript, 'a real transcript');
  });
  test('mergeSessions: newest-first order and the cap are preserved', () => {
    const mk = (id, day) => ({ id, date: '2026-08-' + String(day).padStart(2,'0') + 'T10:00:00Z', updatedAt: id });
    const out = H.mergeSessions([mk(1,1), mk(3,3)], [mk(2,2), mk(4,4)], 3);
    eq(out.length, 3);
    eq(out[0].id, 4);
    eq(out[2].id, 2);
  });
  test('mergeSessions: null and empty inputs are safe', () => {
    eq(H.mergeSessions(null, null, 100).length, 0);
    eq(H.mergeSessions([{ id: 1, date: '2026-08-31T10:00:00Z' }], null, 100).length, 1);
    eq(H.mergeSessions(null, [{ id: 1, date: '2026-08-31T10:00:00Z' }], 100).length, 1);
  });
  test('mergeSessions: a record with no id cannot displace real ones', () => {
    const out = H.mergeSessions([{ date: '2026-08-31T10:00:00Z' }], [{ id: 1, date: '2026-08-31T10:00:00Z' }], 100);
    eq(out.length, 1);
    eq(out[0].id, 1);
  });

  // ── Interrupted recordings ───────────────────────────────────────────────────

  test('isInterruptedRecording: only a session still claiming to record', () => {
    ok(H.isInterruptedRecording({ transcriptionStatus: 'recording' }));
    ok(!H.isInterruptedRecording({ transcriptionStatus: 'queued' }));
    ok(!H.isInterruptedRecording({ transcriptionStatus: 'completed' }));
    ok(!H.isInterruptedRecording(null));
  });
  test('findInterruptedSessions: picks them out of a mixed list', () => {
    const list = [
      { id: 1, transcriptionStatus: 'completed' },
      { id: 2, transcriptionStatus: 'recording' },
      { id: 3, transcriptionStatus: 'error' },
      { id: 4, transcriptionStatus: 'recording' },
    ];
    eq(H.findInterruptedSessions(list).map(s => s.id).join(','), '2,4');
    eq(H.findInterruptedSessions([]).length, 0);
    eq(H.findInterruptedSessions(null).length, 0);
  });

  // ── Session grouping by day ──────────────────────────────────────────────────

  test('groupSessionsByDay: same local day groups together, order preserved', () => {
    const list = [
      { id: 3, date: '2026-08-31T20:30:00.000Z' },
      { id: 2, date: '2026-08-31T15:30:00.000Z' },
      { id: 1, date: '2026-08-30T15:30:00.000Z' },
    ];
    const groups = H.groupSessionsByDay(list);
    eq(groups.length, 2);
    eq(groups[0].sessions.length, 2);
    eq(groups[1].sessions.length, 1);
    // Newest day first, matching the order sessions arrive in.
    ok(groups[0].sessions[0].id === 3);
  });
  test('groupSessionsByDay: tolerates an empty or missing list', () => {
    eq(H.groupSessionsByDay([]).length, 0);
    eq(H.groupSessionsByDay(null).length, 0);
  });
  test('dayKey: an unparseable date does not collapse into a real day', () => {
    eq(H.dayKey('not a date'), 'undated');
    eq(H.dayKey(undefined), 'undated');
  });
  test('dayLabel: today, yesterday, older, and another year', () => {
    const now = new Date(2026, 7, 31, 12, 0, 0);
    eq(H.dayLabel(new Date(2026, 7, 31, 9, 0, 0).toISOString(), now), 'Today');
    eq(H.dayLabel(new Date(2026, 7, 30, 9, 0, 0).toISOString(), now), 'Yesterday');
    eq(H.dayLabel(new Date(2026, 7, 28, 9, 0, 0).toISOString(), now), 'Aug 28');
    eq(H.dayLabel(new Date(2025, 11, 3, 9, 0, 0).toISOString(), now), 'Dec 3, 2025');
    eq(H.dayLabel('nonsense', now), 'Undated');
  });

  // ── Transcript word count ────────────────────────────────────────────────────

  test('countWords: speaker labels are not counted as spoken words', () => {
    eq(H.countWords('Speaker A: hello there\nSpeaker B: hi'), 3);
  });
  test('countWords: plain text and odd spacing', () => {
    eq(H.countWords('  one   two \n three '), 3);
    eq(H.countWords(''), 0);
    eq(H.countWords(null), 0);
  });

  // ── Transcription error mapping ──────────────────────────────────────────────

  test('assemblyErrorMessage: exhausted credits name the top-up page', () => {
    ok(H.assemblyErrorMessage(402, '').indexOf('credits are used up') !== -1);
    ok(H.assemblyErrorMessage(400, 'insufficient balance').indexOf('credits are used up') !== -1);
  });
  test('assemblyErrorMessage: auth failures point at the key', () => {
    ok(H.assemblyErrorMessage(401, '').toLowerCase().indexOf('api key') !== -1);
    ok(H.assemblyErrorMessage(403, '').toLowerCase().indexOf('api key') !== -1);
  });
  test('assemblyErrorMessage: rate limit, server error, and offline are distinct', () => {
    ok(H.assemblyErrorMessage(429, '').indexOf('rate-limiting') !== -1);
    ok(H.assemblyErrorMessage(503, '').indexOf('server error') !== -1);
    ok(H.assemblyErrorMessage(0, '').indexOf('internet connection') !== -1);
  });
  test('assemblyErrorMessage: every message promises the audio is safe', () => {
    [0, 400, 401, 402, 429, 500, 418].forEach(code => {
      ok(H.assemblyErrorMessage(code, '').indexOf('audio is saved') !== -1,
         'code ' + code + ' should reassure that audio is saved');
    });
  });

  // ── Note-generation error mapping ────────────────────────────────────────────

  test('noteErrorMessage: every message leads with the transcript being saved', () => {
    [0, 400, 401, 404, 429, 500, 529, 418].forEach(code => {
      ok(H.noteErrorMessage(code, '').indexOf('The transcript is saved') === 0,
         'code ' + code + ' should open by saying the transcript is saved');
    });
  });
  test('noteErrorMessage: auth failures point at the Keys button', () => {
    ok(H.noteErrorMessage(401, '').indexOf('Keys button') !== -1);
    ok(H.noteErrorMessage(400, 'invalid x-api-key').indexOf('Keys button') !== -1);
  });
  test('noteErrorMessage: an out-of-credit account names the console', () => {
    ok(H.noteErrorMessage(400, 'Your credit balance is too low').indexOf('console.anthropic.com') !== -1);
  });
  test('noteErrorMessage: rate limit, overload, server, and offline are distinct', () => {
    ok(H.noteErrorMessage(429, '').indexOf('rate-limiting') !== -1);
    ok(H.noteErrorMessage(529, '').indexOf('overloaded') !== -1);
    ok(H.noteErrorMessage(500, '').indexOf('server error') !== -1);
    ok(H.noteErrorMessage(0, '').indexOf('internet connection') !== -1);
  });
  test('noteErrorMessage: a model/access failure blames access, not the transcript', () => {
    ok(H.noteErrorMessage(404, 'model: claude-opus-5').indexOf('Claude API access') !== -1);
  });

  // ── Transcription status vocabulary ──────────────────────────────────────────

  test('transcriptionLabel: a session banked at record start reads as recording', () => {
    eq(H.transcriptionLabel('recording'), 'Recording…');
  });
  test('needsTranscription: a session still recording owes a transcript', () => {
    // It is banked to history the moment recording starts, so a page death
    // mid-session leaves a record that resumeUnfinishedWork() can offer back.
    ok(H.needsTranscription({ hasAudio: true, transcriptionStatus: 'recording', transcript: '' }));
  });
  test('transcriptionLabel: known states read as progress', () => {
    eq(H.transcriptionLabel('uploading'), 'Uploading audio…');
    eq(H.transcriptionLabel('queued'), 'Queued at AssemblyAI…');
    eq(H.transcriptionLabel('processing'), 'Transcribing…');
    eq(H.transcriptionLabel('error'), 'Transcription failed');
  });
  test('transcriptionLabel: unknown state renders nothing', () => {
    eq(H.transcriptionLabel('banana'), '');
    eq(H.transcriptionLabel(undefined), '');
  });

  // ── Session state predicates ─────────────────────────────────────────────────

  test('needsTranscription: audio present but no text', () => {
    ok(H.needsTranscription({ hasAudio: true, transcript: '' }));
    ok(H.needsTranscription({ hasAudio: true, transcript: '   ' }));
  });
  test('needsTranscription: false once text exists, or when there is no audio', () => {
    eq(H.needsTranscription({ hasAudio: true, transcript: 'real words' }), false);
    eq(H.needsTranscription({ hasAudio: false, transcript: '' }), false);
    eq(H.needsTranscription(null), false);
  });

  test('sessionHasNote: real content in any field counts', () => {
    ok(H.sessionHasNote({ soap: { S: 'subjective text' } }));
    ok(H.sessionHasNote({ soap: { S: '', O: '', A: '', P: 'plan text' } }));
  });
  test('sessionHasNote: placeholder dashes and blanks do not count', () => {
    eq(H.sessionHasNote({ soap: { S: '—', O: '—', A: '—', P: '—' } }), false);
    eq(H.sessionHasNote({ soap: { S: '  ' } }), false);
    eq(H.sessionHasNote({ soap: null }), false);
    eq(H.sessionHasNote(null), false);
  });

  // ── Audio retention ──────────────────────────────────────────────────────────

  test('selectAudioToPrune: keeps the most recent recordings untouched', () => {
    const list = [];
    for (let i = 0; i < 5; i++) list.push({ id: i, hasAudio: true, soap: { S: 'note' } });
    deepEq(H.selectAudioToPrune(list, 10), []);
  });

  test('selectAudioToPrune: drops old audio once a note exists', () => {
    const list = [];
    for (let i = 0; i < 5; i++) list.push({ id: i, hasAudio: true, soap: { S: 'note' } });
    deepEq(H.selectAudioToPrune(list, 2), [2, 3, 4]);
  });

  test('selectAudioToPrune: NEVER drops audio for a session without a note', () => {
    // This is the whole safety property: audio is the only copy until a note
    // exists, so age alone must never be enough to delete it.
    const list = [
      { id: 0, hasAudio: true, soap: { S: 'note' } },
      { id: 1, hasAudio: true, soap: null },            // no note — must survive
      { id: 2, hasAudio: true, soap: { S: '—' } },      // placeholder — must survive
      { id: 3, hasAudio: true, soap: { S: 'note' } },
    ];
    deepEq(H.selectAudioToPrune(list, 0), [0, 3]);
  });

  test('selectAudioToPrune: ignores sessions that have no audio left', () => {
    const list = [
      { id: 0, hasAudio: false, soap: { S: 'note' } },
      { id: 1, hasAudio: true,  soap: { S: 'note' } },
    ];
    deepEq(H.selectAudioToPrune(list, 0), [1]);
  });

  test('selectAudioToPrune: null/empty list tolerated', () => deepEq(H.selectAudioToPrune(null, 0), []));

  // ── Spend estimation ─────────────────────────────────────────────────────────

  test('estimateCost: bills per second at the medical-mode rate', () => {
    near(H.estimateCost(3600), 0.36, 1e-9);
    near(H.estimateCost(1800), 0.18, 1e-9);
    eq(H.estimateCost(0), 0);
  });
  test('estimateCost: negative and junk input floor at zero', () => {
    eq(H.estimateCost(-500), 0);
    eq(H.estimateCost('abc'), 0);
    eq(H.estimateCost(null), 0);
  });
  test('estimateCost: honours an explicit rate', () => near(H.estimateCost(3600, 0.21), 0.21, 1e-9));

  test('creditStatus: healthy balance', () => {
    const s = H.creditStatus(10);
    near(s.remaining, 40, 1e-9);
    eq(s.level, 'ok');
  });
  test('creditStatus: warns below $5 remaining', () => {
    eq(H.creditStatus(45.01).level, 'low');
    eq(H.creditStatus(46).level, 'low');
  });
  test('creditStatus: empty at or past the grant, never negative', () => {
    eq(H.creditStatus(50).level, 'empty');
    const over = H.creditStatus(75);
    eq(over.level, 'empty');
    eq(over.remaining, 0);
  });

  test('hoursRemaining: converts dollars back into recording time', () => {
    near(H.hoursRemaining(0.36), 1, 1e-9);
    near(H.hoursRemaining(18), 50, 1e-9);
    eq(H.hoursRemaining(0), 0);
  });

  test('formatUsd: two decimals, never negative', () => {
    eq(H.formatUsd(1.5), '$1.50');
    eq(H.formatUsd(49.994), '$49.99');
    eq(H.formatUsd(-3), '$0.00');
  });

  // ── API key shape checks ─────────────────────────────────────────────────────

  test('isLikelyAnthropicKey: requires the sk-ant- prefix', () => {
    ok(H.isLikelyAnthropicKey('sk-ant-api03-abc123'));
    eq(H.isLikelyAnthropicKey('abc123'), false);
    eq(H.isLikelyAnthropicKey(''), false);
    eq(H.isLikelyAnthropicKey(null), false);
  });
  test('isLikelyAssemblyKey: accepts a 32-char hex key', () => {
    ok(H.isLikelyAssemblyKey('20bcfb5738174dd493d29fa7d81e76b0'));
  });
  test('isLikelyAssemblyKey: rejects short input and anything with whitespace', () => {
    eq(H.isLikelyAssemblyKey('short'), false);
    eq(H.isLikelyAssemblyKey('has spaces in it somewhere here'), false);
    eq(H.isLikelyAssemblyKey(''), false);
    eq(H.isLikelyAssemblyKey(null), false);
  });

  // ── SOAP parsing ─────────────────────────────────────────────────────────────

  test('parseSOAPResponse: plain JSON', () => deepEq(H.parseSOAPResponse('{"S":"s","O":"o","A":"a","P":"p"}'), { S: 's', O: 'o', A: 'a', P: 'p' }));
  test('parseSOAPResponse: strips ```json fences', () => eq(H.parseSOAPResponse('```json\n{"S":"s","O":"o","A":"a","P":"p"}\n```').S, 's'));
  test('parseSOAPResponse: tolerates surrounding prose', () => eq(H.parseSOAPResponse('Here:\n{"S":"s","O":"o","A":"a","P":"p"}\nthanks').P, 'p'));
  test('parseSOAPResponse: repairs a truncated note', () => {
    const out = H.parseSOAPResponse('{"S":"long subjective","O":"mse","A":"assessment","P":"start sertraline and follow');
    eq(out.S, 'long subjective');
    eq(out.A, 'assessment');
    ok(out.P.indexOf('start sertraline') === 0);
  });
  test('repairTruncatedJSON: produces parseable JSON', () => { JSON.parse(H.repairTruncatedJSON('{"P":"unterminated')); });
  test('parseSOAPResponse: throws on unsalvageable garbage', () => throws(() => H.parseSOAPResponse('not json at all')));

  // ── Legacy draft recovery ────────────────────────────────────────────────────

  test('isDraftRestorable: only non-empty transcripts', () => {
    ok(H.isDraftRestorable({ transcript: 'real content' }));
    eq(H.isDraftRestorable({ transcript: '   ' }), false);
    eq(H.isDraftRestorable({ transcript: '' }), false);
    eq(H.isDraftRestorable(null), false);
    eq(H.isDraftRestorable({}), false);
  });

  // ── Session history upsert ───────────────────────────────────────────────────

  test('upsertSession: inserts a new session at the front', () => {
    const out = H.upsertSession([{ id: 1, transcript: 'old' }], { id: 2, transcript: 'new' });
    eq(out.length, 2);
    eq(out[0].id, 2);
    eq(out[1].id, 1);
  });
  test('upsertSession: replaces an existing session in place (same id)', () => {
    const list = [{ id: 2, transcript: 'no note' }, { id: 1, transcript: 'old' }];
    const out = H.upsertSession(list, { id: 2, transcript: 'no note', soap: { S: 's' } });
    eq(out.length, 2);
    eq(out[0].id, 2);
    ok(out[0].soap, 'soap should be attached to the existing entry');
    eq(out[1].id, 1);
  });
  test('upsertSession: does not mutate the input list', () => {
    const list = [{ id: 1 }];
    H.upsertSession(list, { id: 2 });
    eq(list.length, 1);
  });
  test('upsertSession: caps the list, dropping the oldest', () => {
    const list = [];
    for (let i = 5; i >= 1; i--) list.push({ id: i });
    const out = H.upsertSession(list, { id: 6 }, 3);
    deepEq(out.map(s => s.id), [6, 5, 4]);
  });
  test('upsertSession: null/empty list tolerated', () => {
    const out = H.upsertSession(null, { id: 1 });
    eq(out.length, 1);
    eq(out[0].id, 1);
  });

  // ── Diagnostics ──────────────────────────────────────────────────────────────

  test('formatDiagnostics: renders events and never needs transcript text', () => {
    const report = H.formatDiagnostics(
      [{ t: '2026-08-24T12:00:00Z', event: 'record_start' }, { t: '2026-08-24T12:01:00Z', event: 'transcribe_error', detail: 'network' }],
      { generatedAt: '2026-08-24T12:05:00Z', userAgent: 'TestUA', audioMime: 'audio/mp4' }
    );
    ok(report.indexOf('record_start') !== -1);
    ok(report.indexOf('transcribe_error') !== -1);
    ok(report.indexOf('network') !== -1);
    ok(report.indexOf('TestUA') !== -1);
    ok(report.indexOf('audio/mp4') !== -1);
  });
  test('formatDiagnostics: handles empty log', () => {
    ok(H.formatDiagnostics([], { userAgent: 'x' }).indexOf('no events') !== -1);
  });

  return cases;
});
