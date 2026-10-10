# Pushback

An AI that calls companies for you. Give it an account and a goal (lower the internet bill, cancel SiriusXM, get a late fee refunded) and it dials the company, gets through the phone menu, waits on hold, talks to the rep, and stops at the limits you set. You only get pulled in when they need something only you have. Afterwards it keeps track of every rate, confirmation number and promise, and reminds you before the promo runs out.

It started as a rebuild of Pine (19pine.ai, Bay Area, founded 2024, $25M Series A). Pine showed people really want to hand off the worst phone calls of their month. Its reviews show where it falls short: users say they ended up doing most of the work, got asked again for details they'd already given, were called at random times, and paid success fees on tasks that didn't happen. Pushback keeps the idea and fixes those parts. The research is in `~/dev/reports/SF consumer AI shortlist 2026-10.md` and `~/dev/reports/Pine teardown 2026-10.md`.

## What it does

Before a call
- Accounts hold the account number, address, current price and promo end date. Import a bill (paste the text, or drop a PDF or screenshot) and the fields fill in. Equipment rental fees get flagged.
- PINs, SSN digits, security answers and birthdays are saved once, encrypted with your macOS keychain.
- A case is one goal on one account with your limits: target price, the most you'd accept, the longest contract, whether you're actually willing to cancel, and whether it can accept inside those limits without asking.
- Pushback writes a plan from the company's playbook (phone menu path, what they verify, tactics, competitor prices) plus anything learned on past calls, and lists what it still needs from you before dialing so the call never stalls on it.
- Dry run: play the whole call against a simulated phone menu, hold queue and retention rep (easy, normal or stubborn) before spending a real call.

During a call
- Phone menus are parsed and the right digits pressed, heading for the retention or loyalty desk when that's where the money is. Speech menus get a few words. Repeated menus fall back to the operator.
- Hold is detected from recorded phrases and music energy, and Pushback waits quietly. A notification fires when a person picks up.
- It always opens by saying it's an AI assistant calling for you and that the call is recorded.
- It never sees your secrets. The model writes `{{pin}}`; the real value is filled in on your Mac right before text to speech, and anything the rep reads back is masked before it goes into the transcript.
- Limits are enforced in code. If the model tries to accept a price above your line or a longer contract than you allowed, the call pauses with "Let me check that with Jordan" and you get a one tap approve or push back.
- If the rep asks for something that isn't saved, you get asked once, in the app, and the call continues.
- Live view with every phase, the transcript, the offers so far marked inside or outside your limits, a box to type a line for it to say, take over, transfer to your phone, or hang up.

After a call
- Result, old and new price, confirmation number, rep name, how long the new rate lasts, and every promise the rep made with a date.
- Reminders before the promo ends and when a promised credit should have posted. Import the next bill and the saving is marked confirmed, or flagged as missed with a follow-up.
- Letters for when a call isn't enough: cancellation, refund request, follow-up on broken promises, an FCC or CFPB complaint, a card dispute. Drafts only. Pushback never sends anything.
- What worked gets added to the company's playbook for next time.
- A share card for wins.

## Pushback vs Pine

| | Pine | Pushback |
|---|---|---|
| Price | 25% of savings with a pre-auth hold, or $100 to $290 a month in credits that expire | Your own keys. A typical 30 minute call costs about $1 to $2 in phone and model usage |
| Getting your info | Asks during the task, at unpredictable times | Collected once before the call; the call only pauses for things that weren't saved |
| Secrets | Sent to their servers | Encrypted locally, never sent to the model |
| Your limits | Strategy is a black box | Written down per case and enforced in code |
| During the call | Notifications, transcript afterwards | Live transcript, phases, offers, approve or push back, take over, transfer to you |
| Results | Savings claims that don't match each other ($3M vs $37M) | Savings count as claimed until a bill confirms them |
| Follow-ups | Spawn as separate tasks | Promises, reminders and letters stay on the same case |
| Practice | No | Dry runs against a simulated retention rep |

## Run it

Requirements: macOS, Node 22+.

```
npm install
npm run dev
```

With no keys, Pushback runs in rehearsal mode: a built-in negotiator plays against the simulated reps, and every screen works. "Load demo accounts" on the home screen adds four accounts and cases to try.

To use Claude, add an Anthropic key in Settings (or `ANTHROPIC_API_KEY` in `.env`, see `.env.example`). It uses Claude Opus 5.5 at low effort for live turns on the phone and medium for plans, summaries and letters. With a key you can also have Claude play the rep in dry runs.

To place real calls you need:
- A Twilio account (upgraded; trial accounts can only call verified numbers) with a phone number, and its SID and auth token.
- A Deepgram key for transcription (nova-3) and speech (Aura-2), both on 8 kHz phone audio.
- A public URL so Twilio can reach the app. Settings has a button that starts a `cloudflared` quick tunnel (`brew install cloudflared`), or paste an ngrok https URL.

Check each company's number against your bill before a real call. The numbers in the built-in playbooks are a starting point.

## How it's built

```
src/engine/            everything testable without Electron
  call.ts              call session: phases, phone menus, hold, turns, guardrails, approvals, asking you, watchdogs
  ivr.ts               menu parsing, digit choice, hold / human / voicemail / closed classification
  offers.ts            offer parsing and limit checks
  vault.ts             secret placeholders, local fill, masking and redaction
  sim.ts               simulated phone line: menus, hold queue, scripted or Claude-played rep with an offer ladder
  rehearsal.ts         offline negotiator used when there is no key (and as a fallback if the model errors)
  claude.ts prompts.ts Claude client (structured output, prompt caching, server-side fallbacks) and prompts
  twilio.ts            Twilio Media Streams server, outbound calls, in-band and out-of-band DTMF, signature checks
  deepgram.ts          streaming STT turn assembly and Aura-2 TTS
  audio.ts             mulaw, DTMF tone generation and detection, music energy gate
  planner.ts outcome.ts letters.ts bill.ts merchants.ts store.ts
src/main/              Electron main: window, IPC, settings in the keychain, tunnel, demo data
src/renderer/          React app: home, accounts, cases, live call, playbooks, settings, share card
```

## Tests

```
npm test            # 28 tests
npm run typecheck
```

The tests run whole calls against the simulated line (lowering a bill through menu, hold and loyalty; a missing PIN; approvals; limits; cancelling; refunds; a stubborn rep that wants the holder's authorization), drive the Twilio line against a fake Twilio and a fake Deepgram (call creation, media stream, TTS playback with marks, DTMF tones decoded back to digits, hang up, signature checks), and run a full call through the Claude client against a fake Anthropic API to check the request shape and that no secret ever reaches the model.

`PUSHBACK_SEED=1 PUSHBACK_AUTOCALL=0 npm run rehearse` loads the demo and starts a dry run on launch.

## Using it honestly

Pushback only calls about accounts you hold or are authorized on, says it's an AI on every call, and never claims to be you. Some companies require the account holder on the line; use "Transfer to my phone" for those. Recording laws vary by state, so it announces the recording at the start of every call.
