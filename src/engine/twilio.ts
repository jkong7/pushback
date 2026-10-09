import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { Line, LineEvents } from "./line.ts";
import type { Stt, Tts } from "./deepgram.ts";
import { EnergyGate, dtmfTones } from "./audio.ts";

export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validTwilio(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface MediaMsg {
  event: "connected" | "start" | "media" | "mark" | "dtmf" | "stop";
  streamSid?: string;
  start?: { streamSid: string; callSid: string; customParameters?: Record<string, string> };
  media?: { payload: string; track?: string };
  mark?: { name: string };
}

export class PhoneServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private lines = new Map<string, TwilioLine>();
  port = 0;

  async start(port = 8787): Promise<number> {
    if (this.server) return this.port;
    this.server = createServer((req, res) => this.http(req, res));
    this.wss = new WebSocketServer({ server: this.server, path: "/media" });
    this.wss.on("connection", (ws) => this.socket(ws));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  stop() {
    this.wss?.close();
    this.server?.close();
    this.server = null;
  }

  register(token: string, line: TwilioLine) {
    this.lines.set(token, line);
  }

  unregister(token: string) {
    this.lines.delete(token);
  }

  private http(req: IncomingMessage, res: ServerResponse) {
    const m = req.url?.match(/^\/status\/([a-f0-9]{32})$/);
    if (req.method !== "POST" || !m) {
      res.writeHead(req.url === "/health" ? 200 : 404).end(req.url === "/health" ? "ok" : "");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const line = this.lines.get(m[1]);
      const params = Object.fromEntries(new URLSearchParams(body));
      if (!line || !line.verify(req.url!, params, req.headers["x-twilio-signature"] as string | undefined)) {
        res.writeHead(403).end();
        return;
      }
      line.status(params);
      res.writeHead(204).end();
    });
  }

  private socket(ws: WebSocket) {
    let line: TwilioLine | null = null;
    const timer = setTimeout(() => !line && ws.close(), 10000);
    ws.on("message", (data) => {
      let msg: MediaMsg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.event === "start") {
        const token = msg.start?.customParameters?.token ?? "";
        line = this.lines.get(token) ?? null;
        clearTimeout(timer);
        if (!line) return ws.close();
        line.attach(ws, msg.start!.streamSid, msg.start!.callSid);
        return;
      }
      line?.message(msg);
    });
    ws.on("close", () => line?.detached(ws));
  }
}

export interface TwilioOpts {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  publicUrl: string;
  server: PhoneServer;
  stt: () => Stt;
  tts: Tts;
  record?: boolean;
  apiBase?: string;
}

export class TwilioLine extends EventEmitter<LineEvents> implements Line {
  readonly kind = "twilio" as const;
  readonly token = randomBytes(16).toString("hex");
  callSid = "";
  private o: TwilioOpts;
  private ws: WebSocket | null = null;
  private streamSid = "";
  private stt: Stt | null = null;
  private gate = new EnergyGate();
  private marks = new Map<string, () => void>();
  private markN = 0;
  private ended = false;
  private resuming = false;
  private ttsAbort: AbortController | null = null;
  private stopTimer: NodeJS.Timeout | null = null;

  constructor(opts: TwilioOpts) {
    super();
    this.o = opts;
  }

  private host() {
    return this.o.publicUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }

  private api(path: string) {
    return `${this.o.apiBase ?? "https://api.twilio.com"}/2010-04-01/Accounts/${this.o.accountSid}${path}`;
  }

  private async rest(path: string, form: Record<string, string | string[]>) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    const res = await fetch(this.api(path), { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message ?? "request failed"}`);
    return json;
  }

  private streamTwiml(prefix = "", resume = false) {
    return `<Response>${prefix}<Connect><Stream url="wss://${xml(this.host())}/media"><Parameter name="token" value="${this.token}"/>${resume ? '<Parameter name="resume" value="1"/>' : ""}</Stream></Connect></Response>`;
  }

  verify(path: string, params: Record<string, string>, signature: string | undefined) {
    return validTwilio(this.o.authToken, `https://${this.host()}${path}`, params, signature);
  }

  async dial() {
    this.o.server.register(this.token, this);
    const res = await this.rest("/Calls.json", {
      To: this.o.to,
      From: this.o.from,
      Twiml: this.streamTwiml(),
      StatusCallback: `https://${this.host()}/status/${this.token}`,
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: "60",
      TimeLimit: "14400",
      ...(this.o.record ? { Record: "true" } : {}),
    });
    this.callSid = String(res.sid ?? "");
  }

  status(params: Record<string, string>) {
    const s = params.CallStatus;
    if (s === "in-progress" || s === "answered") this.emit("connected");
    if (["completed", "busy", "failed", "no-answer", "canceled"].includes(s)) this.finish(s === "completed" ? "call completed" : `call ${s}`);
  }

  attach(ws: WebSocket, streamSid: string, callSid: string) {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.ws = ws;
    this.streamSid = streamSid;
    this.callSid ||= callSid;
    this.resuming = false;
    if (!this.stt) {
      this.stt = this.o.stt();
      this.stt.on("heard", (h) => {
        this.gate.words();
        this.emit("heard", h);
      });
      this.stt.on("error", (e) => this.emit("error", e));
    }
    this.emit("connected");
  }

  detached(ws: WebSocket) {
    if (ws !== this.ws) return;
    this.ws = null;
    for (const done of this.marks.values()) done();
    this.marks.clear();
    if (this.resuming || this.ended) return;
    this.stopTimer = setTimeout(() => this.finish("stream closed"), 4000);
  }

  message(msg: MediaMsg) {
    if (msg.event === "media" && msg.media?.payload) {
      const buf = Buffer.from(msg.media.payload, "base64");
      this.stt?.write(buf);
      if (this.gate.frame(buf) === "music") this.emit("music");
    } else if (msg.event === "mark" && msg.mark) {
      const done = this.marks.get(msg.mark.name);
      this.marks.delete(msg.mark.name);
      done?.();
    } else if (msg.event === "stop" && !this.resuming) {
      this.stopTimer = setTimeout(() => this.finish("stream stopped"), 4000);
    }
  }

  private send(obj: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private play(audio: Buffer): Promise<void> {
    if (!this.ws) return Promise.resolve();
    for (let i = 0; i < audio.length; i += 8000) this.send({ event: "media", streamSid: this.streamSid, media: { payload: audio.subarray(i, i + 8000).toString("base64") } });
    const name = `m${++this.markN}`;
    const wait = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.marks.delete(name);
        resolve();
      }, (audio.length / 8000) * 1000 + 3000);
      this.marks.set(name, () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.send({ event: "mark", streamSid: this.streamSid, mark: { name } });
    return wait;
  }

  async say(text: string) {
    if (this.ended) return;
    this.ttsAbort = new AbortController();
    const audio = await this.o.tts.synth(text, this.ttsAbort.signal).catch((e) => {
      if ((e as Error).name !== "AbortError") this.emit("error", (e as Error).message);
      return null;
    });
    if (!audio || this.ended) return;
    this.emit("speaking", true);
    await this.play(audio);
    this.emit("speaking", false);
  }

  async press(digits: string, opts: { outOfBand?: boolean } = {}) {
    if (this.ended) return;
    if (opts.outOfBand && this.callSid) {
      this.resuming = true;
      await this.rest(`/Calls/${this.callSid}.json`, { Twiml: this.streamTwiml(`<Play digits="w${xml(digits)}"/>`, true) });
      return;
    }
    await this.play(dtmfTones(digits));
  }

  interrupt() {
    this.ttsAbort?.abort();
    this.send({ event: "clear", streamSid: this.streamSid });
  }

  async handoff(phone: string) {
    this.resuming = true;
    await this.rest(`/Calls/${this.callSid}.json`, { Twiml: `<Response><Dial>${xml(phone)}</Dial></Response>` });
    this.finish("handed off to you");
  }

  async hangup() {
    if (this.ended) return;
    if (this.callSid) await this.rest(`/Calls/${this.callSid}.json`, { Status: "completed" }).catch((e) => this.emit("error", (e as Error).message));
    this.finish("hung up");
  }

  private finish(reason: string) {
    if (this.ended) return;
    this.ended = true;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stt?.close();
    this.ws?.close();
    this.o.server.unregister(this.token);
    this.emit("ended", reason);
  }
}
