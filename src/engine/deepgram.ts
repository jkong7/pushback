import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface SttEvents {
  heard: [{ text: string; final: boolean }];
  speech: [];
  error: [string];
  close: [];
}

export interface Stt extends EventEmitter<SttEvents> {
  write(mulaw: Buffer): void;
  close(): void;
}

export interface Tts {
  synth(text: string, signal?: AbortSignal): Promise<Buffer>;
}

interface DgResults {
  type: "Results";
  is_final: boolean;
  speech_final: boolean;
  channel: { alternatives: { transcript: string }[] };
}

export class TurnAssembler {
  private finals: string[] = [];

  push(raw: string): { text: string; final: boolean }[] {
    let msg: DgResults | { type: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return [];
    }
    if (msg.type === "UtteranceEnd") return this.flush();
    if (msg.type !== "Results") return [];
    const r = msg as DgResults;
    const text = r.channel.alternatives[0]?.transcript?.trim() ?? "";
    if (r.is_final) {
      if (text) this.finals.push(text);
      if (r.speech_final) return this.flush();
      return this.finals.length ? [{ text: this.finals.join(" "), final: false }] : [];
    }
    return text ? [{ text: [...this.finals, text].join(" "), final: false }] : [];
  }

  flush(): { text: string; final: boolean }[] {
    if (!this.finals.length) return [];
    const text = this.finals.join(" ");
    this.finals = [];
    return [{ text, final: true }];
  }
}

const base = () => process.env.DEEPGRAM_BASE_URL ?? "https://api.deepgram.com";

export class DeepgramStt extends EventEmitter<SttEvents> implements Stt {
  private ws: WebSocket;
  private queue: Buffer[] = [];
  private batch: Buffer[] = [];
  private batchBytes = 0;
  private assembler = new TurnAssembler();
  private keepAlive: NodeJS.Timeout;

  constructor(apiKey: string, keyterms: string[] = []) {
    super();
    const params = new URLSearchParams({ model: "nova-3", encoding: "mulaw", sample_rate: "8000", channels: "1", interim_results: "true", endpointing: "400", utterance_end_ms: "1200", vad_events: "true", smart_format: "true" });
    for (const k of keyterms.slice(0, 20)) params.append("keyterm", k);
    this.ws = new WebSocket(`${base().replace(/^http/, "ws")}/v1/listen?${params}`, { headers: { Authorization: `Token ${apiKey}` } });
    this.ws.on("open", () => {
      for (const b of this.queue) this.ws.send(b);
      this.queue = [];
    });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString();
      if (raw.includes('"SpeechStarted"')) this.emit("speech");
      for (const ev of this.assembler.push(raw)) this.emit("heard", ev);
    });
    this.ws.on("error", (e) => this.emit("error", `Deepgram: ${e.message}`));
    this.ws.on("close", () => this.emit("close"));
    this.keepAlive = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, 5000);
  }

  write(mulaw: Buffer) {
    this.batch.push(mulaw);
    this.batchBytes += mulaw.length;
    if (this.batchBytes < 640) return;
    const chunk = Buffer.concat(this.batch);
    this.batch = [];
    this.batchBytes = 0;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(chunk);
  }

  close() {
    clearInterval(this.keepAlive);
    for (const ev of this.assembler.flush()) this.emit("heard", ev);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
      setTimeout(() => this.ws.close(), 500);
    } else this.ws.terminate();
  }
}

export class DeepgramTts implements Tts {
  private apiKey: string;
  private voice: string;

  constructor(apiKey: string, voice = "aura-2-thalia-en") {
    this.apiKey = apiKey;
    this.voice = voice;
  }

  async synth(text: string, signal?: AbortSignal): Promise<Buffer> {
    const params = new URLSearchParams({ model: this.voice, encoding: "mulaw", sample_rate: "8000", container: "none" });
    const res = await fetch(`${base()}/v1/speak?${params}`, { method: "POST", headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal });
    if (!res.ok) throw new Error(`Deepgram TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
