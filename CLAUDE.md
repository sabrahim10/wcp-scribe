# Scribe — West County Physicians

AI-powered medical scribe web app. Single HTML file hosted on GitHub Pages. Records patient sessions via browser speech recognition, transcribes in real time, and generates structured SOAP notes via the Anthropic API.

## Project Structure

```
wcp-scribe/
├── index.html      # Entire app — UI, recording logic, API call (renamed from scribe.html)
├── CLAUDE.md       # This file
└── README.md       # Optional
```

## What This App Does

1. Physician opens the URL on their work laptop in Chrome
2. On first use, pastes Anthropic API key (stored in localStorage, persists across sessions)
3. Hits the record button — browser Web Speech API transcribes speech in real time
4. Hits stop when session ends
5. Clicks "Generate SOAP Note" — transcript is sent to Claude API
6. Structured S/O/A/P note appears, ready to copy into EHR

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS — no build step, no framework, no dependencies
- **Speech:** Web Speech API (built into Chrome/Edge — no external service)
- **AI:** Anthropic Claude API (`claude-sonnet-4-20250514`) via direct browser fetch
- **Hosting:** GitHub Pages (static, free)
- **Auth:** None — security through private repo + obscure URL + localStorage key storage

## API Key Handling

The Anthropic API key is entered by the user on first load and stored in `localStorage` under the key `scribe_key`. It persists until the user clears browser storage. It is sent directly from the browser to `api.anthropic.com` over HTTPS.

**This is acceptable for personal/internal use on a private work laptop.** For a production multi-user deployment, replace with a Vercel serverless proxy so the key never touches the client.

## Claude API Call

- **Model:** `claude-sonnet-4-20250514`
- **Max tokens:** 1500
- **Input:** Raw transcript text
- **Output:** JSON object with keys `S`, `O`, `A`, `P`
- **Prompt role:** Psychiatric scribe — uses proper psychiatric terminology, only uses information present in the transcript

## Key Constraints

- Must work as a **single HTML file** — no build process, no npm, no bundler
- Must work in **Chrome on desktop** (Web Speech API requirement)
- No backend — everything runs in the browser
- No patient names should be used in sessions (HIPAA best practice)
- Keep the GitHub repo **private**

## Potential Improvements (Future)

- [ ] Vercel proxy to move API key server-side
- [ ] Anthropic BAA for HIPAA compliance
- [ ] Patient session history (localStorage or Firebase)
- [ ] Export to PDF
- [ ] Specialty-specific SOAP templates (psychiatry vs general)
- [ ] Speaker diarization (separate physician vs patient speech)
- [ ] Auto-save transcript every 30 seconds in case of accidental tab close

## SOAP Note Prompt

The system prompt instructs Claude to act as a psychiatric medical scribe. It:
- Returns only a JSON object (no markdown, no preamble)
- Maps transcript content to S/O/A/P sections
- Notes "Not documented in this session" for objective fields not mentioned
- Uses proper psychiatric terminology
- Does not hallucinate information not present in the transcript

## Common Issues

**Speech recognition not working:** Must use Chrome or Edge. Safari does not support Web Speech API. Microphone permission must be granted.

**API key error:** Key must start with `sk-ant-`. If getting 401, the key may be invalid or expired. Clear localStorage and re-enter.

**SOAP note parsing error:** Claude returned malformed JSON. Retry — this is rare but can happen. If persistent, check the raw transcript for unusual characters.

**Recognition stops mid-session:** Web Speech API has a timeout on silence. If the patient pauses for more than ~60 seconds, recognition may stop. The stop/start button resets it.
