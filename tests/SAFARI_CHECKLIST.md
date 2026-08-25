# Safari QA Checklist — WCP Scribe

The automated tests (`npm test` and `tests/harness.html`) verify the *logic*. They
**cannot** exercise the real microphone, IndexedDB under pressure, a real upload, or
the actual fan — those only surface on the physical machine. Run this checklist on
the MacBook that had the problems (Safari) before trusting a release.

> **What changed in Tier 2:** the app no longer uses the Web Speech API, so Apple's
> speech servers and the macOS Dictation setting are no longer involved at all.
> Audio is recorded with `MediaRecorder`, written to IndexedDB as it records, and
> uploaded to AssemblyAI after the session ends. The failures worth hunting are now
> microphone permission, storage, and network — not speech-service settings.

---

## 0. One-time system settings

- [ ] Microphone permission is **Allowed** for the site (Safari ▸ Settings ▸ Websites ▸ Microphone).
- [ ] The right input device is selected in **System Settings ▸ Sound ▸ Input**, and the
      input level meter there moves when you speak.
- [ ] **Not in Private Browsing** — Safari blocks IndexedDB there, which would defeat
      the crash protection. The harness (step 1) will catch this.
- [ ] Dictation/Siri settings are now **irrelevant**. Nothing needs to be turned on.

## 1. Harness check (1 min)

```
cd wcp-scribe && python3 -m http.server 8000
```
then open `http://localhost:8000/tests/harness.html` in Safari (**not** via `file://` —
Safari blocks the `../helpers.js` load and every helper comes up undefined).

- [ ] Summary reads **"All N tests passed in this browser"**.
- [ ] **Check capabilities** → all four capabilities `yes`; negotiated container should
      be `audio/mp4;codecs=mp4a.40.2` in Safari (Chrome picks WebM/Opus).
- [ ] **Run round-trip** → ✅ audio survives IndexedDB. *If this fails, stop* — a
      recording would not survive a closed tab on this machine.
- [ ] **Run simulation** → ✅ speaker turns merged, fallback works.

## 2. Smoke test (3 min)

- [ ] Open the app in Safari. No error banner on load.
- [ ] Click record, grant mic. **The level meter bars should move when you speak** —
      this is the honest proof capture is alive; the timer alone is not.
- [ ] Speak for ~30 seconds, then stop.
- [ ] Status shows **Uploading audio… → Queued… → Transcribing…**, then the transcript
      appears with `Speaker A:` / `Speaker B:` labels.
- [ ] Click **Generate SOAP Note**. A structured S/O/A/P note appears.
- [ ] Confirm the estimated credit meter went down by roughly the right amount.

## 3. The fan / heat test (the "airplane engine" issue)

- [ ] Start recording and let it run **15–20 minutes** (talk periodically, or leave a
      podcast playing near the mic).
- [ ] The fan should stay quiet. The level meter is compositor-only (`transform`)
      and repaints at ~12fps, so it should cost far less than the old waveform.
- [ ] Optional: Activity Monitor ▸ CPU — Safari's usage should be modest, not pinned.

## 4. The long-session test (the original "error over time" issue)

- [ ] Record a **full ~60 minutes**. Speak on and off; include long silent gaps.
- [ ] **There should be no beeping** — the macOS restart beep came from Web Speech's
      5-second no-speech timeout, which no longer exists.
- [ ] **Switch to another app / another Space for a few minutes mid-session.** Recording
      must keep going — this used to kill capture and is the main thing Tier 2 fixes.
- [ ] Stop. Upload takes longer for a long session (~25 MB); the transcript should
      still arrive within a couple of minutes.
- [ ] Generate the note — the SOAP output should not be cut off mid-sentence.

## 5. Crash recovery test (no more lost intakes)

- [ ] Start recording, speak for a minute.
- [ ] **Close the tab (or quit Safari) mid-session.**
- [ ] Reopen the app. A banner reports a recorded session with no transcript yet.
- [ ] Click **Transcribe now** → the audio recorded up to the crash is transcribed and
      the note can be generated from it. *Nothing is lost.*

## 6. Failure-path test (this is the important one)

- [ ] Open **Keys**, replace the AssemblyAI key with garbage of the right shape
      (32 random hex characters), save.
- [ ] Record 15 seconds and stop. You should get a clear message about the **key**
      being rejected, plus a **Transcribe from saved audio** button — and the sidebar
      should flag the session **Needs transcript**.
- [ ] Restore the real key via **Keys**, then click **Transcribe from saved audio**.
      The transcript should arrive normally. *This proves a bad key delays a note
      rather than losing one.*
- [ ] Repeat with wifi turned off to confirm the offline message behaves the same way.

## 7. Diagnostics test

- [ ] While an error banner is showing, a small **"Copy diagnostics"** link appears.
      Click it, paste into Notes — confirm it lists events/timestamps, the browser, and
      the negotiated audio format, and contains **no patient/transcript text**.

---

### If something fails
Click **Copy diagnostics** (or, in Safari's Web Inspector console, run
`localStorage.getItem('scribe_diag')`) and send that text — it's PHI-free and shows
the sequence of events leading to the failure.

To inspect saved audio directly: Web Inspector ▸ Storage ▸ Indexed Databases ▸
`scribe_audio` ▸ `chunks`. Each row is one 5-second slice of a recording.
