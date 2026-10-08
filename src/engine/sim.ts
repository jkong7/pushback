import { EventEmitter } from "node:events";
import type { Line, LineEvents } from "./line.ts";
import { sleep, speechMs } from "./line.ts";
import type { Account, Brain, Case, Merchant, SimMenu, SimOffer } from "./types.ts";
import { REP_SCHEMA, REP_SYSTEM, transcriptText } from "./prompts.ts";

export type Dept = "billing" | "retention" | "cancel";
export type Difficulty = "easy" | "normal" | "stubborn";

export interface RepReply {
  say: string;
  transfer: "none" | "retention" | "supervisor" | "hold";
  end: boolean;
}

export interface Rep {
  greet(dept: Dept): Promise<string>;
  respond(agent: string): Promise<RepReply>;
}

const RX = {
  ai: /\b(ai|a\.i\.|assistant|automated|virtual)\b/i,
  competitor: /t-mobile|at&t|verizon|xfinity|fiber|5g|competitor|offering|spotify|visible|mint|affinity|other provider/i,
  cancel: /\b(cancel|disconnect|switch(ing)? (providers|carriers|over)|close (the|my) account|end (the )?service)\b/i,
  loyalty: /\b(loyalty|retention)\b/i,
  supervisor: /\b(supervisor|manager)\b/i,
  accept: /\b(that works|i'?ll take|we'?ll take|(they|we|holder) (would like to |will )?accept|accept (that|it|the)|let'?s do (it|that)|please apply|go ahead and apply|sounds good,? please)\b/i,
  decline: /\b(too high|can you do better|still (more|higher|too)|not enough|more than|decline|no thanks|best you can do|anything lower|any lower|lower than that|doesn'?t work)\b/i,
  done: /\b(that'?s (all|everything|it)|nothing else|no,? (that'?s|thank)|goodbye|have a (good|great))\b/i,
  promo: /\b(promotion|promo|discount|deal|lower|reduce|bring (it|the bill) down|better (rate|price))\b/i,
  refund: /\b(refund|credit|charge|charged|dispute|reverse|waive)\b/i,
  freeze: /\bfreeze\b/i,
};

const digitsOf = (s: string) => s.replace(/\D/g, "");

export class ScriptedRep implements Rep {
  private dept: Dept = "billing";
  private verified = false;
  private askedVerify = 0;
  private unlocked = new Set<SimOffer["unlock"]>(["ask"]);
  private offered: SimOffer[] = [];
  private current: SimOffer | null = null;
  private declines = 0;
  private stage: "open" | "verify" | "authorize" | "help" | "confirm" | "wrap" | "done" = "open";
  private name = "";
  private confirmation = `PB${Math.floor(100000 + Math.random() * 899999)}`;
  private authorized = false;
  private nameOk = false;
  private given = new Set<string>();
  private aiSaid = false;

  private disclosed(agent: string) {
    if (RX.ai.test(agent)) this.aiSaid = true;
    return this.aiSaid;
  }

  private merchant: Merchant;
  private account: Account;
  private kase: Case;
  private difficulty: Difficulty;

  constructor(merchant: Merchant, account: Account, kase: Case, difficulty: Difficulty = "normal") {
    this.merchant = merchant;
    this.account = account;
    this.kase = kase;
    this.difficulty = difficulty;
  }

  async greet(dept: Dept): Promise<string> {
    this.dept = dept;
    const names = this.merchant.sim.repNames;
    this.name = names[(dept === "billing" ? 0 : 1) % names.length];
    if (this.stage === "open" || this.stage === "verify") this.stage = this.verified ? "help" : "verify";
    if (dept === "billing") return `Thank you for calling ${this.merchant.name.split(" (")[0]}, my name is ${this.name}. Can I get the name on the account?`;
    if (this.verified) return `Hi, this is ${this.name} on the loyalty team. I see you've been a customer with us for a while. What can I do to keep you with us today?`;
    return `Hi, you've reached the loyalty team, this is ${this.name}. Can I get the name on the account?`;
  }

  async respond(agent: string): Promise<RepReply> {
    const r = (say: string, extra: Partial<RepReply> = {}): RepReply => ({ say, transfer: "none", end: false, ...extra });
    this.disclosed(agent);
    if (this.stage === "done") return r("Thank you, have a good day.", { end: true });

    if (/\b(one more moment|one moment while|still here|check (that|this) with)\b/i.test(agent) && !digitsOf(agent)) return r("Sure, take your time.");
    if (this.stage === "verify") {
      const need = this.merchant.sim.requires;
      if (agent.toLowerCase().includes(this.account.holder.toLowerCase().split(" ")[0])) this.nameOk = true;
      for (const k of need) {
        const v = digitsOf(this.account.secrets[k] ?? "");
        if (!v || digitsOf(agent).includes(v)) this.given.add(k);
      }
      if (this.nameOk && need.every((k) => this.given.has(k))) {
        this.verified = true;
        if (this.difficulty === "stubborn" && this.disclosed(agent) && !this.authorized) {
          this.stage = "authorize";
          return r(`Okay. Since you're calling on their behalf, I'll need ${this.account.holder.split(" ")[0]} to confirm they authorize you to make changes. Can they confirm that?`);
        }
        this.stage = "help";
        return r(`Thank you, I've verified the account. ${RX.ai.test(agent) ? "And thanks for letting me know you're an assistant. " : ""}How can I help you today?`);
      }
      this.askedVerify++;
      if (this.askedVerify > 4) {
        this.stage = "done";
        return r("I'm sorry, I'm not able to verify the account, so I can't make changes today. The account holder is welcome to call us directly. Goodbye.", { end: true });
      }
      if (!this.nameOk) return r("I'll need the full name on the account first.");
      const k = need.find((x) => !this.given.has(x))!;
      const label = { pin: "the account PIN", last4: "the last four of the social on the account", security: "the answer to the security question", dob: "the date of birth on the account" }[k];
      const wrong = digitsOf(agent).length >= 4;
      return r(wrong ? `I'm sorry, that doesn't match what I have. Can you give me ${label} again?` : `Thanks. And for security, can I get ${label}?`);
    }

    if (this.stage === "authorize") {
      if (/\b(confirm|authori[sz]e|approve|yes)\b/i.test(agent)) {
        this.authorized = true;
        this.stage = "help";
        return r("Perfect, I've noted the authorization on the account. What can I help with today?");
      }
      return r("I do need that confirmation before I can go further.");
    }

    if (this.stage === "confirm") {
      if (this.current && RX.accept.test(agent) && /instead|rather than/i.test(agent)) return this.accept();
      if (RX.done.test(agent) || /\b(no|nope)\b/i.test(agent)) {
        this.stage = "done";
        return r(`Thank you for being a customer${this.name ? `, this was ${this.name}` : ""}. Have a great day.`, { end: true });
      }
      if (/\b(confirm|confirmation|reference|repeat|name)\b/i.test(agent)) return r(`Sure. Your confirmation number is ${this.spell(this.confirmation)}, and my name is ${this.name}. Anything else?`);
      return r("Is there anything else I can help you with today?");
    }

    if (this.kase.kind === "refund" || this.kase.kind === "dispute") return this.refund(agent);
    if (this.kase.kind === "cancel") return this.cancel(agent);
    return this.lower(agent);
  }

  private spell(code: string) {
    return code.split("").join(" ");
  }

  private next(): SimOffer | null {
    return this.merchant.sim.offers.find((o) => this.unlocked.has(o.unlock) && !this.offered.includes(o) && (this.dept === "retention" || o.unlock !== "loyalty")) ?? null;
  }

  private present(o: SimOffer, lead: string): RepReply {
    this.offered.push(o);
    this.current = o;
    const contract = /contract/.test(o.description) ? "" : o.months ? ", no contract" : "";
    return { say: `${lead} I can offer you ${o.description}${contract}. Would you like me to apply that?`, transfer: "none", end: false };
  }

  private accept(): RepReply {
    const o = this.current!;
    this.stage = "confirm";
    const ends = new Date(Date.now() + o.months * 30.4 * 86400000).toISOString().slice(0, 10);
    const rate = o.monthly > 0 ? `Your new rate is $${o.monthly} a month plus taxes starting next bill, for ${o.months} months, ending ${ends}. ` : "";
    return { say: `Done, I've applied that. ${rate}Your confirmation number is ${this.spell(this.confirmation)}, and you'll get an email confirming the change. Is there anything else?`, transfer: "none", end: false };
  }

  private lower(agent: string): RepReply {
    if (RX.competitor.test(agent)) this.unlocked.add("competitor");
    if (RX.supervisor.test(agent)) this.unlocked.add("supervisor");
    if (this.current && RX.accept.test(agent)) return this.accept();
    if (this.dept === "billing" && (RX.cancel.test(agent) || RX.loyalty.test(agent) || (this.declines >= 2 && this.difficulty !== "easy"))) {
      this.unlocked.add("cancel");
      return { say: "I understand. Let me transfer you to our loyalty team, they have more options. One moment please.", transfer: "retention", end: false };
    }
    const pushing = RX.decline.test(agent) || RX.cancel.test(agent) || (this.dept === "retention" && RX.loyalty.test(agent));
    if (this.current && pushing) this.declines++;
    if (this.dept === "retention" && (pushing || RX.competitor.test(agent))) {
      this.unlocked.add("cancel");
      if (this.declines >= (this.difficulty === "stubborn" ? 2 : 1)) this.unlocked.add("loyalty");
    }
    const o = this.next();
    if (o) {
      const lead = this.offered.length === 0 ? (this.dept === "retention" ? "Let me see what I can do." : "Let me take a look at your account.") : this.dept === "retention" ? "Okay, let me check with my system." : "I may have something else.";
      if (this.difficulty === "stubborn" && this.offered.length === 0 && this.dept === "billing" && !RX.competitor.test(agent)) {
        this.declines++;
        return { say: "I'm showing you're already on our standard rate, so I don't see any promotions on the account right now.", transfer: "none", end: false };
      }
      return this.present(o, lead);
    }
    if (this.current && pushing) {
      if (this.dept === "billing") return { say: "That's the best I'm able to do from billing. Would you like me to transfer you to loyalty?", transfer: "none", end: false };
      if (RX.cancel.test(agent) && this.kase.limits.allowCancel) {
        this.stage = "confirm";
        return { say: `Understood. I've scheduled the disconnect for ten days from today, confirmation ${this.spell(this.confirmation)}. If you change your mind, just call back before then. Anything else?`, transfer: "none", end: false };
      }
      return { say: "I'm sorry, that's really the lowest I can go. Would you like to keep the current offer?", transfer: "none", end: false };
    }
    if (RX.promo.test(agent)) return { say: "I'm not seeing any promotions on the account right now. You're on our standard rate.", transfer: "none", end: false };
    return { say: "Okay. What would you like to do with the account today?", transfer: "none", end: false };
  }

  private cancel(agent: string): RepReply {
    if (this.current && RX.accept.test(agent)) return this.accept();
    const declined = RX.decline.test(agent) || /\b(no|just cancel|still (want|like) to cancel|proceed)\b/i.test(agent);
    if (this.offered.length < this.merchant.sim.saveAttempts && (RX.cancel.test(agent) || declined)) {
      this.unlocked.add("cancel");
      if (this.offered.length) this.unlocked.add("loyalty");
      const o = this.merchant.sim.offers.find((x) => !this.offered.includes(x));
      if (o) return this.present(o, this.offered.length ? "Before I do that, one more option." : "I'm sorry to hear you want to leave. Before I cancel,");
    }
    if (RX.cancel.test(agent) || declined) {
      this.stage = "confirm";
      return { say: `Okay, I've cancelled the service effective today. You won't be billed again. Your cancellation confirmation number is ${this.spell(this.confirmation)}. Anything else?`, transfer: "none", end: false };
    }
    return { say: "How can I help with your membership today?", transfer: "none", end: false };
  }

  private refund(agent: string): RepReply {
    const amount = this.kase.limits.refundAmount ?? 50;
    if (this.current && RX.accept.test(agent)) {
      this.stage = "confirm";
      return { say: `Done. I've issued a credit of $${this.current.monthly} to the account. It'll show on your next statement in one to two billing cycles. Your reference number is ${this.spell(this.confirmation)}. Anything else?`, transfer: "none", end: false };
    }
    if (!this.offered.length && RX.refund.test(agent)) {
      const half = Math.round(amount / 2);
      const o: SimOffer = { monthly: this.difficulty === "easy" ? amount : half, months: 0, description: "", unlock: "ask" };
      o.description = `a one-time courtesy credit of $${o.monthly}`;
      return this.present(o, `I see that charge of $${amount}.`);
    }
    if (this.offered.length === 1 && (RX.decline.test(agent) || RX.supervisor.test(agent) || /\bfull\b/i.test(agent))) {
      const o: SimOffer = { monthly: amount, months: 0, description: `a credit for the full $${amount}`, unlock: "supervisor" };
      return this.present(o, "Let me check with my supervisor. Okay, they approved it.");
    }
    return { say: "What charge are you calling about?", transfer: "none", end: false };
  }
}

export class ClaudeRep implements Rep {
  private lines: { who: string; text: string }[] = [];
  private dept: Dept = "billing";

  private brain: Brain;
  private merchant: Merchant;
  private account: Account;
  private kase: Case;
  private difficulty: Difficulty;

  constructor(brain: Brain, merchant: Merchant, account: Account, kase: Case, difficulty: Difficulty) {
    this.brain = brain;
    this.merchant = merchant;
    this.account = account;
    this.kase = kase;
    this.difficulty = difficulty;
  }

  private context() {
    const sim = this.merchant.sim;
    return [
      `Company: ${this.merchant.name}`,
      `Your department: ${this.dept}`,
      `Customer on file: ${this.account.holder}, plan ${this.account.plan}, $${this.account.monthly} a month`,
      `Verification you require: name on account${sim.requires.length ? ` and ${sim.requires.join(", ")}` : ""}. Correct values: ${sim.requires.map((k) => `${k}=${this.account.secrets[k] ?? "(not on file)"}`).join(", ") || "none"}`,
      `Offer ladder (in order; loyalty offers only in retention): ${sim.offers.map((o) => `${o.description} [unlocked by ${o.unlock}]`).join("; ")}`,
      `Save attempts before you accept a cancellation: ${sim.saveAttempts}`,
      `Difficulty: ${this.difficulty}`,
      `When the caller accepts, give a confirmation number like PB${Math.floor(100000 + Math.random() * 899999)} digit by digit and your name.`,
      `Case type the caller has: ${this.kase.kind}`,
    ].join("\n");
  }

  async greet(dept: Dept): Promise<string> {
    this.dept = dept;
    const reply = await this.brain.json<RepReply>({ task: "rep", system: REP_SYSTEM, context: this.context(), prompt: `You just picked up a transferred call in ${dept}. Greet the caller.`, data: { greet: dept } }, REP_SCHEMA);
    this.lines.push({ who: "REP", text: reply.say });
    return reply.say;
  }

  async respond(agent: string): Promise<RepReply> {
    this.lines.push({ who: "CALLER", text: agent });
    const reply = await this.brain.json<RepReply>({ task: "rep", system: REP_SYSTEM, context: this.context(), prompt: `${transcriptText(this.lines)}\n\nReply as the rep.`, data: { agent } }, REP_SCHEMA);
    this.lines.push({ who: "REP", text: reply.say });
    return reply;
  }
}

type SimState = "idle" | "menu" | "hold" | "rep" | "ended";

export class SimLine extends EventEmitter<LineEvents> implements Line {
  readonly kind = "sim" as const;
  private state: SimState = "idle";
  private menu: SimMenu;
  private menuRepeats = 0;
  private abort = new AbortController();
  private menuTimer: NodeJS.Timeout | null = null;
  private holdLoop: NodeJS.Timeout | null = null;
  private pending: Promise<void> = Promise.resolve();

  private merchant: Merchant;
  private rep: Rep;
  private speed: number;

  constructor(merchant: Merchant, rep: Rep, speed = 1) {
    super();
    this.merchant = merchant;
    this.rep = rep;
    this.speed = speed;
    this.menu = merchant.sim.menu;
  }

  private ms(n: number) {
    return n / this.speed;
  }

  private speak(text: string) {
    if (this.state === "ended") return;
    const words = text.split(" ");
    if (words.length > 8) this.emit("heard", { text: words.slice(0, Math.ceil(words.length / 2)).join(" "), final: false });
    this.emit("heard", { text, final: true });
  }

  async dial() {
    await sleep(this.ms(1200), this.abort.signal);
    this.emit("connected");
    this.enterMenu(this.menu);
  }

  private enterMenu(menu: SimMenu) {
    this.state = "menu";
    this.menu = menu;
    this.speak(menu.prompt);
    this.armMenuTimeout();
  }

  private armMenuTimeout() {
    if (this.menuTimer) clearTimeout(this.menuTimer);
    this.menuTimer = setTimeout(() => {
      if (this.state !== "menu") return;
      this.menuRepeats++;
      if (this.menuRepeats >= 3) return this.toHold("billing");
      this.speak(`Sorry, I didn't get that. ${this.menu.prompt}`);
      this.armMenuTimeout();
    }, this.ms(12000));
  }

  private route(next: MenuNext) {
    if (!next) {
      this.speak(`That option isn't available right now. ${this.menu.prompt}`);
      this.armMenuTimeout();
      return;
    }
    if (typeof next === "object") return this.enterMenu(next);
    this.toHold(next === "hold" ? "billing" : next === "cancel" ? "billing" : next);
  }

  private toHold(dept: Dept) {
    if (this.menuTimer) clearTimeout(this.menuTimer);
    this.state = "hold";
    this.speak(dept === "retention" ? "Please hold while I transfer your call to the right department." : "Thank you. Please hold for the next available representative. Your call is important to us.");
    const total = this.ms(this.merchant.sim.holdSeconds * 1000);
    const started = Date.now();
    let tick = 0;
    this.holdLoop = setInterval(() => {
      if (this.state !== "hold") return;
      tick++;
      if (tick % 3 === 0) this.speak("Thank you for holding. All of our representatives are currently assisting other customers. Please continue to hold.");
      else this.emit("music");
      if (Date.now() - started >= total) {
        clearInterval(this.holdLoop!);
        this.state = "rep";
        this.pending = this.rep.greet(dept).then((t) => this.speak(t)).catch((e) => this.fail(e));
      }
    }, Math.max(20, this.ms(2500)));
  }

  private fail(e: unknown) {
    this.emit("error", String((e as Error)?.message ?? e));
    void this.hangup();
  }

  async say(text: string) {
    if (this.state === "ended") return;
    this.emit("speaking", true);
    await sleep(this.ms(speechMs(text)), this.abort.signal);
    this.emit("speaking", false);
    if (this.state === "menu" && this.menu.speech) {
      const t = text.toLowerCase();
      if (/\b(representative|agent|operator|human)\b/.test(t)) return this.toHold("billing");
      const hit = this.menu.options.find((o) => o.label.split(" ").filter((w) => w.length > 3).some((w) => t.includes(w)));
      return this.route(hit?.next);
    }
    if (this.state === "menu") {
      if (/\b(representative|agent|operator)\b/i.test(text)) return this.toHold("billing");
      return;
    }
    if (this.state !== "rep") return;
    this.pending = this.pending.then(async () => {
      const reply = await this.rep.respond(text);
      await sleep(this.ms(500 + Math.min(1500, reply.say.length * 8)), this.abort.signal);
      if (this.state !== "rep") return;
      this.speak(reply.say);
      if (reply.transfer === "retention" || reply.transfer === "supervisor") {
        await sleep(this.ms(800), this.abort.signal);
        this.toHold("retention");
      } else if (reply.end) {
        await sleep(this.ms(600), this.abort.signal);
        this.end("rep ended the call");
      }
    }).catch((e) => this.fail(e));
  }

  async press(digits: string) {
    if (this.state !== "menu") return;
    await sleep(this.ms(300 + digits.length * 200), this.abort.signal);
    const d = digits.replace(/[^0-9*#]/g, "")[0];
    const opt = this.menu.options.find((o) => o.digit === d);
    if (!opt) {
      this.speak(`Sorry, that's not a valid option. ${this.menu.prompt}`);
      this.armMenuTimeout();
      return;
    }
    this.route(opt.next);
  }

  interrupt() {}

  private end(reason: string) {
    if (this.state === "ended") return;
    this.state = "ended";
    if (this.menuTimer) clearTimeout(this.menuTimer);
    if (this.holdLoop) clearInterval(this.holdLoop);
    this.abort.abort();
    this.emit("ended", reason);
  }

  async hangup() {
    this.end("hung up");
  }
}

type MenuNext = SimMenu["options"][number]["next"];
