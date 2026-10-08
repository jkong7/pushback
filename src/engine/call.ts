import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Line } from "./line.ts";
import type { Account, AgentTurn, Brain, Case, CallEvent, CallState, EventKind, Lesson, Merchant, Need, Offer, Outcome } from "./types.ts";
import { Vault } from "./vault.ts";
import { AGENT_SYSTEM, IVR_SCHEMA, IVR_SYSTEM, OUTCOME_SCHEMA, OUTCOME_SYSTEM, TURN_SCHEMA, caseContext, transcriptText } from "./prompts.ts";
import { classify, chooseDigit, menuKey, parseMenu, speechIntent } from "./ivr.ts";
import { describeOffer, parseOffer, withinLimits } from "./offers.ts";
import { rehearsalTurn, type TurnData } from "./rehearsal.ts";
import { extractOutcome } from "./outcome.ts";

export interface Timing {
  debounceMs: number;
  menuMs: number;
  needTimeoutMs: number;
  maxHoldMs: number;
  maxTurns: number;
  silenceMs: number;
}

export const DEFAULT_TIMING: Timing = { debounceMs: 700, menuMs: 1300, needTimeoutMs: 180000, maxHoldMs: 60 * 60000, maxTurns: 60, silenceMs: 15000 };

export interface CallDeps {
  id?: string;
  kase: Case;
  account: Account;
  merchant: Merchant;
  lessons: Lesson[];
  line: Line;
  brain: Brain;
  vault?: Vault;
  timing?: Partial<Timing>;
}

interface Events {
  event: [CallEvent];
  state: [CallState];
  need: [Need];
  resolved: [string];
  offer: [Offer];
  human: [];
  ended: [{ outcome: Outcome; holdMs: number; endedAt: number; reason: string }];
}

const STATE_LABEL: Record<CallState, string> = { dialing: "Dialing", ivr: "Phone menu", hold: "On hold", human: "Talking to a person", wrapup: "Wrapping up", ended: "Call ended" };

const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];

function similar(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / A.size;
}

const offerKey = (o: Offer) => `${o.monthly}|${o.months}|${o.credit}`;

export class CallSession extends EventEmitter<Events> {
  readonly id: string;
  state: CallState = "dialing";
  readonly events: CallEvent[] = [];
  readonly lines: { who: string; text: string }[] = [];
  readonly vault: Vault;
  startedAt = Date.now();
  holdMs = 0;
  bestOffer: Offer | null = null;
  paused = false;
  outcome: Outcome | null = null;
  private d: CallDeps;
  private t: Timing;
  private holdStart = 0;
  private busy = false;
  private pending = false;
  private turnTimer: NodeJS.Timeout | null = null;
  private menuTimer: NodeJS.Timeout | null = null;
  private menuBuffer = "";
  private menuSeen = new Map<string, number>();
  private tried: string[] = [];
  private lastPressKey = "";
  private needs = new Map<string, { need: Need; key?: string; timer: NodeJS.Timeout }>();
  private approved = new Set<string>();
  private answers = 0;
  private turns = 0;
  private speaking = false;
  private lastSpoken = { text: "", at: 0 };
  private lastStall = 0;
  private ended = false;
  private everHuman = false;
  private holdWatch: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private silences = 0;

  constructor(deps: CallDeps) {
    super();
    this.d = deps;
    this.id = deps.id ?? randomUUID();
    this.t = { ...DEFAULT_TIMING, ...deps.timing };
    this.vault = deps.vault ?? new Vault(deps.account);
  }

  get awaiting() {
    return this.needs.size > 0;
  }

  async start() {
    const { line } = this.d;
    line.on("heard", (h) => this.onHeard(h.text, h.final));
    line.on("music", () => {
      if (this.state === "dialing" || this.state === "ivr") this.setState("hold");
    });
    line.on("speaking", (s) => (this.speaking = s));
    line.on("error", (e) => this.record("system", `Line error: ${e}`));
    line.on("ended", (reason) => void this.finish(reason));
    this.record("system", `Calling ${this.d.merchant.name}${this.d.line.kind === "sim" ? " (simulated line)" : ""}`);
    this.setState("dialing");
    try {
      await line.dial();
    } catch (e) {
      this.record("system", `Couldn't place the call: ${(e as Error).message}`);
      await this.finish("dial failed");
    }
  }

  private record(kind: EventKind, text: string, data?: unknown): CallEvent {
    const ev: CallEvent = { id: randomUUID(), callId: this.id, at: Date.now(), kind, text, data };
    if (kind !== "partial") this.events.push(ev);
    this.emit("event", ev);
    return ev;
  }

  private setState(s: CallState) {
    if (s === this.state) return;
    if (this.state === "hold") this.holdMs += Date.now() - this.holdStart;
    if (s === "hold") {
      this.holdStart = Date.now();
      if (this.holdWatch) clearTimeout(this.holdWatch);
      this.holdWatch = setTimeout(() => {
        if (this.state !== "hold") return;
        this.record("system", `On hold longer than ${Math.round(this.t.maxHoldMs / 60000)} minutes, hanging up to try later`);
        void this.d.line.hangup();
      }, this.t.maxHoldMs);
    }
    this.state = s;
    this.record("state", STATE_LABEL[s]);
    this.emit("state", s);
  }

  private onHeard(text: string, final: boolean) {
    if (this.ended || !text.trim()) return;
    if (!final) {
      this.record("partial", this.d.line.kind === "sim" ? text : this.vault.mask(text));
      if (this.speaking && this.state === "human" && words(text).length >= 3 && similar(text, this.lastSpoken.text) < 0.6) this.d.line.interrupt();
      return;
    }
    if (similar(text, this.lastSpoken.text) > 0.8 && Date.now() - this.lastSpoken.at < 4000) return;
    this.silences = 0;
    this.armSilence();
    const masked = this.vault.mask(text);
    this.record("them", masked);
    const c = classify(text);
    if (this.state !== "human") {
      if (c === "voicemail" || c === "closed") {
        this.lines.push({ who: "PHONE", text: masked });
        this.record("system", c === "closed" ? "They're closed right now" : "Reached a voicemail");
        void this.d.line.hangup();
        return;
      }
      const novelOnHold = this.state === "hold" && c === "other" && words(text).length >= 6;
      if (c === "human" || novelOnHold) {
        this.lines.push({ who: "REP", text: masked });
        this.toHuman();
        this.scheduleTurn();
        return;
      }
      this.lines.push({ who: "PHONE", text: masked });
      if (c === "menu" || c === "speech-menu" || c === "verify-bot" || (this.state === "ivr" && c === "other")) {
        this.setState("ivr");
        this.menuBuffer = `${this.menuBuffer} ${text}`.trim();
        if (this.menuTimer) clearTimeout(this.menuTimer);
        this.menuTimer = setTimeout(() => void this.handleMenu(), this.t.menuMs);
        return;
      }
      if (c === "hold") this.setState("hold");
      return;
    }
    if (c === "hold" && /\b(please hold|transferring|transfer your call|hold while)\b/i.test(text)) {
      this.lines.push({ who: "REP", text: masked });
      this.setState("hold");
      return;
    }
    this.lines.push({ who: "REP", text: masked });
    if (this.awaiting) {
      if (/\?\s*$/.test(text) && Date.now() - this.lastStall > 10000) {
        this.lastStall = Date.now();
        void this.speak("I'm still here, just one more moment please.");
      }
      return;
    }
    this.scheduleTurn();
  }

  private toHuman() {
    if (this.state === "human") return;
    this.setState("human");
    if (!this.everHuman) {
      this.everHuman = true;
      this.record("system", "A person picked up");
      this.emit("human");
    }
  }

  private async handleMenu() {
    const text = this.menuBuffer;
    this.menuBuffer = "";
    if (this.ended || this.state !== "ivr" || this.paused) return;
    const c = classify(text);
    const key = menuKey(text.replace(/^sorry[^.]*\.\s*/i, ""));
    const seen = (this.menuSeen.get(key) ?? 0) + 1;
    this.menuSeen.set(key, seen);
    const kind = this.d.kase.kind === "lower" && !this.d.kase.limits.allowCancel ? "refund" : this.d.kase.kind;
    if (c === "verify-bot") {
      if (this.vault.has("account_number") && /account number/i.test(text)) {
        const digits = this.vault.fill("{{account_number}}").text.replace(/\D/g, "");
        this.record("digits", "Entered the account number");
        this.lines.push({ who: "KEYPAD", text: "account number" });
        await this.d.line.press(`${digits}#`);
      } else await this.speak("Representative");
      return;
    }
    if (c === "speech-menu" || (!parseMenu(text).length && /\bsay\b/i.test(text))) {
      await this.speak(seen >= 2 ? "Representative" : speechIntent(kind));
      return;
    }
    const items = parseMenu(text);
    if (!items.length) return;
    if (seen >= 3) {
      const zero = items.find((i) => i.digit === "0");
      if (zero) return this.press("0", "operator", key, true);
      return void this.speak("Representative");
    }
    let pick = chooseDigit(items, kind, this.tried);
    if (!pick) {
      try {
        const r = await this.d.brain.json<{ action: string; digits: string; say: string }>(
          { task: "ivr", system: IVR_SYSTEM, context: `Goal: ${this.d.kase.kind}: ${this.d.kase.goal}`, prompt: `Menu: ${text}\nAlready tried: ${this.tried.join(", ") || "nothing"}`, data: { items, kind, text, tried: this.tried } },
          IVR_SCHEMA,
        );
        if (r.action === "say" && r.say) return void this.speak(r.say);
        if (r.action === "press" && r.digits) pick = { digit: r.digits, label: items.find((i) => i.digit === r.digits)?.label ?? "model choice" };
      } catch {
        pick = items.find((i) => i.digit === "0") ?? null;
      }
    }
    if (pick) await this.press(pick.digit, pick.label, key, this.lastPressKey === key);
  }

  private async press(digit: string, label: string, key: string, outOfBand: boolean) {
    this.tried.push(`${digit}:${label}`);
    this.lastPressKey = key;
    this.record("digits", `Pressed ${digit} (${label})`, { digit, outOfBand });
    this.lines.push({ who: "KEYPAD", text: `${digit} (${label})` });
    await this.d.line.press(digit, { outOfBand });
  }

  private async speak(text: string, byUser = false) {
    const { text: filled } = this.vault.fill(text);
    this.record("agent", text, byUser ? { byUser } : undefined);
    this.lines.push({ who: "AGENT", text });
    this.lastSpoken = { text: filled, at: Date.now() };
    await this.d.line.say(filled);
  }

  private armSilence() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => void this.onSilence(), this.t.silenceMs);
  }

  private async onSilence() {
    if (this.ended) return;
    if (this.state !== "human" || this.awaiting || this.paused || this.busy) return this.armSilence();
    this.silences++;
    if (this.silences >= 3) {
      this.record("system", "No response for a while, ending the call");
      await this.speak("I haven't heard anything for a bit, so I'll call back another time. Thank you.");
      await this.d.line.hangup();
      return;
    }
    await this.speak(this.silences === 1 ? "Hello, are you still there?" : "Hi, just checking you're still on the line?");
    this.armSilence();
  }

  private scheduleTurn() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => void this.runTurn(), this.t.debounceMs);
  }

  private turnData(): TurnData {
    const { kase, account, merchant } = this.d;
    return { kind: kase.kind, holder: account.holder, plan: account.plan, monthly: account.monthly, limits: kase.limits, details: kase.details, lines: this.lines, available: this.vault.available(), competitors: merchant.competitors };
  }

  private async runTurn() {
    if (this.ended || this.paused || this.awaiting || this.state !== "human") return;
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    try {
      if (++this.turns > this.t.maxTurns) {
        this.record("system", "Too many turns without a result, ending politely");
        await this.speak("Thank you for your help today. We'll call back another time. Goodbye.");
        await this.d.line.hangup();
        return;
      }
      const { kase, account, merchant, lessons } = this.d;
      let turn: AgentTurn;
      try {
        turn = await this.d.brain.json<AgentTurn>(
          {
            task: "turn",
            system: AGENT_SYSTEM,
            context: caseContext(kase, account, merchant, lessons, this.vault.available()),
            prompt: `CALL SO FAR\n${transcriptText(this.lines)}\n\nDecide your next turn. The latest REP line is what you are responding to.`,
            data: this.turnData(),
          },
          TURN_SCHEMA,
        );
      } catch (e) {
        this.record("system", `Model error (${(e as Error).message.slice(0, 80)}), using the offline negotiator for this turn`);
        turn = rehearsalTurn(this.turnData());
      }
      await this.apply(turn);
    } finally {
      this.busy = false;
      if (this.pending) {
        this.pending = false;
        this.scheduleTurn();
      }
    }
  }

  private async apply(turn: AgentTurn) {
    if (this.ended) return;
    const { kase, account } = this.d;
    const lastRep = [...this.lines].reverse().find((l) => l.who === "REP")?.text ?? "";
    const offer = turn.offer ?? (turn.decision !== "none" ? parseOffer(lastRep) : null);
    if (offer && (!this.bestOffer || offerKey(offer) !== offerKey(this.bestOffer))) {
      this.record("offer", offer.description || "Offer", offer);
      this.emit("offer", offer);
      this.bestOffer = offer;
    }
    if (turn.decision === "accept" && offer && !this.approved.has(offerKey(offer))) {
      const verdict = withinLimits(kase.kind, offer, kase.limits, account.monthly);
      if (!verdict.ok || !kase.limits.autoAccept) {
        const first = account.holder.split(" ")[0] || "the account holder";
        await this.speak(`Let me check that with ${first} real quick, one moment please.`);
        const what = describeOffer(offer, account.monthly);
        this.ask({ kind: "approval", question: verdict.ok ? `They're offering ${what}. Accept it?` : `They're offering ${what}, which is outside your limits (${verdict.reason}). Accept anyway?`, secret: false, offer });
        return;
      }
    }
    const recent = this.lines.filter((l) => l.who === "AGENT").slice(-2).map((l) => l.text);
    if (turn.action === "say" && recent.length === 2 && recent.every((t) => t === turn.say)) {
      this.record("system", "The agent was repeating itself, ending the call politely");
      await this.speak("I'm sorry, I think we're going in circles. I'll call back another time. Thank you for your help.");
      await this.d.line.hangup();
      return;
    }
    if (turn.action === "say" || (turn.action === "hang_up" && turn.say)) {
      const { missing } = this.vault.fill(turn.say);
      if (missing.length) {
        await this.speak("One moment while I check that.");
        const label = missing[0].replace(/[{}]/g, "").replace(/_/g, " ");
        this.ask({ kind: "info", question: `The rep needs ${label === "pin" ? "the account PIN" : label === "last4" ? "the last 4 of your SSN" : label}. It isn't saved for this account.`, secret: true }, missing[0]);
        return;
      }
      if (turn.say.trim()) await this.speak(turn.say);
    }
    if (turn.action === "press" && turn.digits) {
      this.record("digits", `Pressed ${turn.digits}`);
      this.lines.push({ who: "KEYPAD", text: turn.digits });
      await this.d.line.press(turn.digits);
    }
    if (turn.action === "ask_user") {
      await this.speak(turn.say?.trim() || "One moment while I check that.");
      this.ask({ kind: "info", question: turn.question || "The rep needs something from you.", secret: turn.secret });
    }
    if (turn.action === "hang_up") {
      this.setState("wrapup");
      await this.d.line.hangup();
    }
  }

  private ask(need: Omit<Need, "id">, key?: string) {
    const id = randomUUID();
    const full: Need = { id, ...need };
    const timer = setTimeout(() => void this.expire(id), this.t.needTimeoutMs);
    this.needs.set(id, { need: full, key, timer });
    this.record("needs", need.question, full);
    this.emit("need", full);
  }

  private async expire(id: string) {
    if (!this.needs.has(id) || this.ended) return;
    this.needs.delete(id);
    this.emit("resolved", id);
    this.record("system", "No answer from you in time, wrapping up the call");
    await this.speak("I'm sorry, I wasn't able to get that right now. We'll call back. Thank you for your help.");
    await this.d.line.hangup();
  }

  answer(id: string, text: string) {
    const n = this.needs.get(id);
    if (!n || this.ended) return false;
    clearTimeout(n.timer);
    this.needs.delete(id);
    this.emit("resolved", id);
    if (n.need.secret) {
      const key = n.key ?? `{{answer_${++this.answers}}}`;
      this.vault.add(key, text);
      this.record("answer", "You answered (kept private, the model never sees it)");
      this.lines.push({ who: "HOLDER", text: `(to you, not on the call) I added it. Say it as ${key}.` });
    } else {
      this.record("answer", text);
      this.lines.push({ who: "HOLDER", text: `(to you, not on the call) ${text}` });
    }
    void this.runTurn();
    return true;
  }

  approve(id: string, yes: boolean) {
    const n = this.needs.get(id);
    if (!n || this.ended || !n.need.offer) return false;
    clearTimeout(n.timer);
    this.needs.delete(id);
    this.emit("resolved", id);
    if (yes) this.approved.add(offerKey(n.need.offer));
    this.record("answer", yes ? "You approved the offer" : "You declined the offer");
    this.lines.push({ who: "HOLDER", text: yes ? "(to you, not on the call) I approve that offer. Accept it." : "(to you, not on the call) Don't accept that offer. Push for more or decline politely." });
    void this.runTurn();
    return true;
  }

  async inject(text: string) {
    if (this.ended || !text.trim()) return;
    await this.speak(text.trim(), true);
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.record("system", p ? "You took over. The agent won't speak until you hand back." : "Handed back to the agent");
    if (!p) this.scheduleTurn();
  }

  async handoff(phone: string) {
    if (!this.d.line.handoff) throw new Error("This line can't transfer the call to your phone");
    this.record("system", `Transferring the call to your phone (${phone.slice(-4).padStart(phone.length, "•")})`);
    this.paused = true;
    await this.d.line.handoff(phone);
  }

  async hangup() {
    this.record("system", "You ended the call");
    await this.d.line.hangup();
  }

  private async finish(reason: string) {
    if (this.ended) return;
    this.ended = true;
    for (const t of [this.turnTimer, this.menuTimer, this.holdWatch, this.silenceTimer]) if (t) clearTimeout(t);
    for (const [id, n] of this.needs) {
      clearTimeout(n.timer);
      this.emit("resolved", id);
    }
    this.needs.clear();
    if (this.state === "hold") this.holdMs += Date.now() - this.holdStart;
    this.state = "ended";
    this.record("state", STATE_LABEL.ended);
    this.emit("state", "ended");
    this.record("system", `Call ended (${reason})`);
    const { kase, account, merchant, brain } = this.d;
    const fallback = extractOutcome(kase, account, this.lines, this.startedAt);
    let outcome = fallback;
    if (brain.name === "claude" && this.everHuman) {
      try {
        const o = await brain.json<Outcome>(
          { task: "outcome", system: OUTCOME_SYSTEM, context: caseContext(kase, account, merchant, [], []), prompt: `Call date: ${new Date(this.startedAt).toISOString().slice(0, 10)}\n\n${transcriptText(this.lines, 400)}`, data: { fallback } },
          OUTCOME_SCHEMA,
        );
        outcome = { ...o, oldMonthly: account.monthly, credit: o.credit ?? 0, lessons: [...new Set([...fallback.lessons.filter((l) => l.startsWith("Phone menu path")), ...o.lessons])] };
      } catch (e) {
        this.record("system", `Couldn't summarize with the model (${(e as Error).message.slice(0, 60)}), used the local summary`);
      }
    }
    this.outcome = outcome;
    this.emit("ended", { outcome, holdMs: this.holdMs, endedAt: Date.now(), reason });
  }
}
