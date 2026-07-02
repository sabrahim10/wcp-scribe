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

  // ── Transcript assembly / Safari double-text ─────────────────────────────────

  test('buildTranscript: joins finals plus live interim', () => {
    const out = H.buildTranscript('', [
      { transcript: 'hello there', isFinal: true },
      { transcript: 'how are', isFinal: false },
    ]);
    eq(out.text, 'hello there how are');
    eq(out.final, 'hello there ');
  });

  test('buildTranscript: dedupes Safari re-emitted final results', () => {
    // Safari sometimes lists the same finalized phrase twice — must not double up.
    const out = H.buildTranscript('', [
      { transcript: 'the patient reports anxiety', isFinal: true },
      { transcript: 'the patient reports anxiety', isFinal: true },
    ]);
    eq(out.text.trim(), 'the patient reports anxiety'); // once, not doubled
  });

  test('buildTranscript: carries base across a restart', () => {
    // Simulates the restart loop: prior session text lives in `base`, new
    // recognition session starts its results list over.
    const out = H.buildTranscript('earlier text ', [{ transcript: 'new words', isFinal: true }]);
    eq(out.text.trim(), 'earlier text new words');
    eq(out.final, 'earlier text new words '); // trailing space keeps next word separate
  });

  test('buildTranscript: distinct consecutive finals are both kept', () => {
    const out = H.buildTranscript('', [
      { transcript: 'first sentence', isFinal: true },
      { transcript: 'second sentence', isFinal: true },
    ]);
    eq(out.text.trim(), 'first sentence second sentence');
  });

  test('buildTranscript: empty/undefined results are safe', () => {
    eq(H.buildTranscript('', []).text, '');
    eq(H.buildTranscript('base ', undefined).text, 'base ');
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

  // ── Auto-save / recovery ─────────────────────────────────────────────────────

  test('serializeDraft round-trips', () => {
    const d = JSON.parse(H.serializeDraft('hello world', 90, '2026-06-30T12:00:00.000Z'));
    eq(d.transcript, 'hello world');
    eq(d.duration, 90);
    eq(d.savedAt, '2026-06-30T12:00:00.000Z');
  });
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

  // ── Error mapping / diagnostics ──────────────────────────────────────────────

  test('friendlyRecognitionError: maps known Safari codes to guidance', () => {
    ok(H.friendlyRecognitionError('service-not-available').indexOf('Dictation') !== -1);
    ok(H.friendlyRecognitionError('not-allowed').indexOf('Dictation') !== -1);
    ok(H.friendlyRecognitionError('audio-capture').toLowerCase().indexOf('microphone') !== -1);
    ok(H.friendlyRecognitionError('network').toLowerCase().indexOf('reconnect') !== -1);
  });
  test('friendlyRecognitionError: unknown code falls back to raw', () => {
    ok(H.friendlyRecognitionError('weird-code').indexOf('weird-code') !== -1);
  });
  test('isTransientRecognitionError: classifies routine vs fatal', () => {
    ok(H.isTransientRecognitionError('no-speech'));
    ok(H.isTransientRecognitionError('aborted'));
    ok(H.isTransientRecognitionError('network'));
    eq(H.isTransientRecognitionError('service-not-available'), false);
    eq(H.isTransientRecognitionError('not-allowed'), false);
  });
  test('formatDiagnostics: renders events and never needs transcript text', () => {
    const report = H.formatDiagnostics(
      [{ t: '2026-06-30T12:00:00Z', event: 'record_start' }, { t: '2026-06-30T12:01:00Z', event: 'recognition_error', detail: 'network' }],
      { generatedAt: '2026-06-30T12:05:00Z', userAgent: 'TestUA', speechSupported: true }
    );
    ok(report.indexOf('record_start') !== -1);
    ok(report.indexOf('recognition_error') !== -1);
    ok(report.indexOf('network') !== -1);
    ok(report.indexOf('TestUA') !== -1);
  });
  test('formatDiagnostics: handles empty log', () => {
    ok(H.formatDiagnostics([], { userAgent: 'x' }).indexOf('no events') !== -1);
  });

  return cases;
});
