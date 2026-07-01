# Safari QA Checklist — WCP Scribe

The automated tests (`npm test` and `tests/harness.html`) verify the *logic*. They
**cannot** exercise the real microphone, Apple's speech servers, or the actual fan —
those only surface on the physical machine. Run this checklist on the MacBook that
had the problems (Safari) before trusting a release.

> Why these steps: Safari sends speech audio to Apple's servers and depends on
> system Dictation/Siri settings, so most real failures are environmental, not code.

---

## 0. One-time system settings (the usual culprits)

- [ ] **Dictation is ON** — System Settings ▸ Keyboard ▸ Dictation. If off, Safari
      throws `service-not-available` and recording never works.
- [ ] **"Listen for 'Hey Siri'" is OFF** (or Siri disabled) — when on, it can
      swallow speech results so the transcript stays empty while the timer runs.
- [ ] Microphone permission is **Allowed** for the site (Safari ▸ Settings ▸ Websites ▸ Microphone).

## 1. Smoke test (2 min)

- [ ] Open the app in Safari. No error banner on load.
- [ ] Click record, grant mic. Wait ~2–3s (Safari has a startup delay), then speak.
- [ ] Words appear in the live transcript within a second or two.
- [ ] Stop. Click **Generate SOAP Note**. A structured S/O/A/P note appears.

## 2. The fan / heat test (the "airplane engine" issue)

- [ ] Start recording and let it run **15–20 minutes** (talk periodically, or leave a
      podcast playing near the mic).
- [ ] The fan should **stay quiet / spin far less** than before. The waveform still
      animates (it's now pure CSS).
- [ ] Optional: open Activity Monitor ▸ CPU and confirm Safari's usage is modest and
      not pinned high while idle-recording.

## 3. The long-session / timeout test (the Safari "error over time" issue)

- [ ] Start a session and let it run a **full ~60 minutes** (a real or simulated
      intake). Speak on and off; include a few long silent gaps (>15s).
- [ ] It should keep transcribing the whole time — no hard error that stops capture.
      Brief "reconnecting…" notices are fine and expected.
- [ ] At the end, the transcript still contains earlier content (nothing was lost on
      the periodic restarts).
- [ ] **Check for doubled text** — scan for phrases repeated back-to-back. There
      should be none.
- [ ] Generate the note — the SOAP output should not be cut off mid-sentence.

## 4. Crash / timeout recovery test (no more lost intakes)

- [ ] Start recording, speak for a minute so there's real transcript.
- [ ] **Force-quit the situation**: close the tab (or quit Safari) mid-session.
- [ ] Reopen the app. A yellow **"Recovered an unsaved transcript… Restore it?"**
      banner appears.
- [ ] Click **Restore** → the transcript comes back and you can generate the note.
- [ ] Start a fresh session, save it (New Session), reload → the restore banner does
      **not** reappear (draft was cleared once saved).

## 5. Diagnostics / error messaging test

- [ ] Temporarily turn **Dictation OFF**, reload, and try to record. You should get a
      helpful message mentioning **Dictation**, not a raw error code.
- [ ] While an error banner is showing, a small **"Copy diagnostics"** link appears.
      Click it, paste into Notes — confirm it lists events/timestamps and the browser,
      and contains **no patient/transcript text**.
- [ ] Turn Dictation back ON.

---

### If something fails
Click **Copy diagnostics** (or, in Safari's Web Inspector console, run
`localStorage.getItem('scribe_diag')`) and send that text — it's PHI-free and shows
the sequence of events leading to the failure.
