import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { PhoneServer, TwilioLine, twilioSignature, validTwilio } from "../src/engine/twilio.ts";
import { DeepgramStt, DeepgramTts, TurnAssembler } from "../src/engine/deepgram.ts";
import { detectDtmf, dtmfTones, linearToMulaw, mulawToLinear } from "../src/engine/audio.ts";

test("mulaw round trips and DTMF tones decode to the right digit", () => {
  for (const v of [0, 100, -100, 5000, -5000, 30000]) assert.ok(Math.abs(mulawToLinear(linearToMulaw(v)) - v) <= Math.max(16, Math.abs(v) * 0.06), String(v));
  for (const d of "1470*#") {
    const tones = dtmfTones(d).subarray(1200, 1200 + 800);
    assert.equal(detectDtmf(tones), d);
  }
});

test("twilio signatures validate and reject tampering", () => {
  const url = "https://abc.trycloudflare.com/status/x";
  const params = { CallSid: "CA1", CallStatus: "completed" };
  const sig = twilioSignature("secret", url, params);
  assert.ok(validTwilio("secret", url, params, sig));
  assert.ok(!validTwilio("secret", url, { ...params, CallStatus: "ringing" }, sig));
  assert.ok(!validTwilio("other", url, params, sig));
});

test("deepgram turn assembly joins finals and ends on speech_final or UtteranceEnd", () => {
  const t = new TurnAssembler();
  const r = (text: string, is_final: boolean, speech_final = false) => JSON.stringify({ type: "Results", is_final, speech_final, channel: { alternatives: [{ transcript: text }] } });
  assert.deepEqual(t.push(r("for billing", false)), [{ text: "for billing", final: false }]);
  assert.deepEqual(t.push(r("for billing press one", true)), [{ text: "for billing press one", final: false }]);
  assert.deepEqual(t.push(r("to cancel press four", true, true)), [{ text: "for billing press one to cancel press four", final: true }]);
  t.push(r("are you there", true));
  assert.deepEqual(t.push(JSON.stringify({ type: "UtteranceEnd" })), [{ text: "are you there", final: true }]);
});

async function fakes() {
  const rest: { path: string; form: URLSearchParams; auth: string }[] = [];
  const speak: { text: string; query: string }[] = [];
  const listenAudio: Buffer[] = [];
  let listenSocket: WebSocket | null = null;
  let listenQuery = "";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url?.startsWith("/v1/speak")) {
        speak.push({ text: JSON.parse(raw).text, query: req.url });
        res.writeHead(200, { "content-type": "audio/basic" });
        res.end(Buffer.alloc(1600, 0xff));
        return;
      }
      rest.push({ path: req.url!, form: new URLSearchParams(raw), auth: String(req.headers.authorization) });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ sid: "CA123" }));
    });
  });
  const wss = new WebSocketServer({ server, path: "/v1/listen" });
  wss.on("connection", (ws, req) => {
    listenSocket = ws;
    listenQuery = req.url ?? "";
    ws.on("message", (d, bin) => bin && listenAudio.push(d as Buffer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.DEEPGRAM_BASE_URL = base;
  return { base, rest, speak, listenAudio, get listen() { return listenSocket; }, get listenQuery() { return listenQuery; }, close: () => { wss.close(); server.close(); } };
}

test("twilio line dials, streams audio to STT, speaks, presses digits and hangs up", async () => {
  const f = await fakes();
  const phone = new PhoneServer();
  const port = await phone.start(0);
  try {
    const line = new TwilioLine({ accountSid: "AC1", authToken: "tok", from: "+15555550100", to: "+18009346489", publicUrl: "https://demo.trycloudflare.com/", server: phone, stt: () => new DeepgramStt("dg-key", ["Xfinity"]), tts: new DeepgramTts("dg-key"), record: true, apiBase: f.base });
    const heard: { text: string; final: boolean }[] = [];
    line.on("heard", (h) => heard.push(h));
    await line.dial();
    const call = f.rest[0];
    assert.equal(call.path, "/2010-04-01/Accounts/AC1/Calls.json");
    assert.equal(call.auth, `Basic ${Buffer.from("AC1:tok").toString("base64")}`);
    assert.equal(call.form.get("To"), "+18009346489");
    assert.equal(call.form.get("Record"), "true");
    assert.deepEqual(call.form.getAll("StatusCallbackEvent"), ["initiated", "ringing", "answered", "completed"]);
    assert.match(call.form.get("Twiml")!, new RegExp(`<Stream url="wss://demo.trycloudflare.com/media"><Parameter name="token" value="${line.token}"/>`));
    assert.equal(line.callSid, "CA123");

    const twilio = new WebSocket(`ws://127.0.0.1:${port}/media`);
    const outbound: { event: string; media?: { payload: string }; mark?: { name: string } }[] = [];
    twilio.on("message", (d) => {
      const m = JSON.parse(d.toString());
      outbound.push(m);
      if (m.event === "mark") twilio.send(JSON.stringify({ event: "mark", streamSid: "MZ1", mark: m.mark }));
    });
    await new Promise((r) => twilio.on("open", r));
    twilio.send(JSON.stringify({ event: "connected" }));
    twilio.send(JSON.stringify({ event: "start", streamSid: "MZ1", start: { streamSid: "MZ1", callSid: "CA123", customParameters: { token: line.token } } }));
    for (let i = 0; i < 8; i++) twilio.send(JSON.stringify({ event: "media", streamSid: "MZ1", media: { payload: Buffer.alloc(160, 0xff).toString("base64") } }));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(f.listenAudio.reduce((n, b) => n + b.length, 0) >= 640);
    assert.match(f.listenQuery, /encoding=mulaw/);
    assert.match(f.listenQuery, /sample_rate=8000/);
    assert.match(f.listenQuery, /keyterm=Xfinity/);

    f.listen!.send(JSON.stringify({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "To cancel service, press 4." }] } }));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(heard.at(-1), { text: "To cancel service, press 4.", final: true });

    await line.say("Hi, I'm an AI assistant calling on behalf of Jordan.");
    assert.equal(f.speak[0].text, "Hi, I'm an AI assistant calling on behalf of Jordan.");
    assert.match(f.speak[0].query, /encoding=mulaw&sample_rate=8000&container=none/);
    assert.ok(outbound.some((m) => m.event === "media"));
    assert.ok(outbound.some((m) => m.event === "mark"));

    const before = outbound.length;
    await line.press("4");
    const tone = Buffer.concat(outbound.slice(before).filter((m) => m.event === "media").map((m) => Buffer.from(m.media!.payload, "base64")));
    assert.equal(detectDtmf(tone.subarray(1200, 2000)), "4");

    await line.press("2", { outOfBand: true });
    const update = f.rest.at(-1)!;
    assert.equal(update.path, "/2010-04-01/Accounts/AC1/Calls/CA123.json");
    assert.match(update.form.get("Twiml")!, /<Play digits="w2"\/><Connect><Stream/);

    const ended = new Promise<string>((r) => line.on("ended", r));
    await line.hangup();
    assert.equal(f.rest.at(-1)!.form.get("Status"), "completed");
    assert.equal(await ended, "hung up");
    twilio.close();
  } finally {
    phone.stop();
    f.close();
  }
});

test("phone server rejects status callbacks without a valid signature", async () => {
  const f = await fakes();
  const phone = new PhoneServer();
  const port = await phone.start(0);
  try {
    const line = new TwilioLine({ accountSid: "AC1", authToken: "tok", from: "+1", to: "+2", publicUrl: "https://demo.example", server: phone, stt: () => new DeepgramStt("k"), tts: new DeepgramTts("k"), apiBase: f.base });
    await line.dial();
    const path = `/status/${line.token}`;
    const body = "CallSid=CA123&CallStatus=completed";
    const bad = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "nope" } });
    assert.equal(bad.status, 403);
    const ended = new Promise<string>((r) => line.on("ended", r));
    const sig = twilioSignature("tok", `https://demo.example${path}`, { CallSid: "CA123", CallStatus: "completed" });
    const good = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig } });
    assert.equal(good.status, 204);
    assert.equal(await ended, "call completed");
  } finally {
    phone.stop();
    f.close();
  }
});
