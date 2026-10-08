import type { AgentTurn, Brain, BrainRequest, CaseKind, Limits, Offer } from "./types.ts";
import { atTarget, describeOffer, effectiveMonthly, parseOffer, withinLimits } from "./offers.ts";

interface Ctx {
  best: Offer | null;
  first: string;
  target: number | null;
}
import { chooseDigit, speechIntent, type MenuItem } from "./ivr.ts";

export interface TurnData {
  kind: CaseKind;
  holder: string;
  plan: string;
  monthly: number;
  limits: Limits;
  details: string;
  lines: { who: string; text: string }[];
  available: string[];
  competitors: { name: string; offer: string }[];
}

export interface IvrData {
  items: MenuItem[];
  kind: CaseKind;
  text: string;
  tried: string[];
}

const turn = (t: Partial<AgentTurn>): AgentTurn => ({ action: "say", say: "", digits: "", question: "", secret: false, offer: null, decision: "none", note: "", ...t });

const ASK_SECRET: [RegExp, string, string][] = [
  [/\b(pin|passcode|pass code)\b/i, "{{pin}}", "the account PIN"],
  [/\b(last (four|4)|social)\b/i, "{{last4}}", "the last 4 of your SSN"],
  [/\bdate of birth|birthday\b/i, "{{dob}}", "your date of birth"],
  [/\bsecurity question\b/i, "{{security}}", "the answer to your security question"],
];

export function rehearsalTurn(d: TurnData): AgentTurn {
  const agentLines = d.lines.filter((l) => l.who === "AGENT").map((l) => l.text);
  const repLines = d.lines.filter((l) => l.who === "REP").map((l) => l.text);
  const said = (re: RegExp) => agentLines.some((t) => re.test(t));
  const last = d.lines.at(-1);
  const lastRep = repLines.at(-1) ?? "";
  const first = d.holder.split(" ")[0] || "the holder";
  const target = d.limits.targetMonthly;
  const lastOffer = [...repLines].reverse().map(parseOffer).find(Boolean) ?? null;
  const inLimits = repLines.map(parseOffer).filter((o): o is Offer => Boolean(o) && withinLimits(d.kind, o!, d.limits, d.monthly).ok);
  const best = inLimits.sort((x, y) => (effectiveMonthly(x, d.monthly) ?? 1e9) - (effectiveMonthly(y, d.monthly) ?? 1e9) || (y.credit ?? 0) - (x.credit ?? 0))[0] ?? null;
  const ctx: Ctx = { best, first, target };
  const repName = [...repLines].reverse().map((t) => t.match(/\b(?:my name is|this is) ([A-Z][a-z]+)/)?.[1]).find(Boolean);

  if (last?.who === "HOLDER") {
    const t = last.text;
    if (/\bapprove/i.test(t) && lastOffer) return turn({ say: `Thanks for waiting. ${first} approves, so please go ahead and apply that.`, offer: lastOffer, decision: "accept" });
    if (/\bdon'?t accept|declin/i.test(t)) return leverage(d, lastOffer, said, ctx, "Thanks for waiting.");
    const key = t.match(/\{\{[a-z0-9_]+\}\}/)?.[0];
    if (key) return turn({ say: `Thanks for waiting. It's ${key}.` });
    if (/authori[sz]/i.test(t)) return turn({ say: `Thanks for waiting. ${first} confirms they authorize me to discuss and make changes on the account.` });
    return turn({ say: `Thanks for waiting. ${t.replace(/^.*?:\s*/, "")}` });
  }
  if (!lastRep) return turn({ action: "wait" });
  if (repLines.length >= 3 && repLines.slice(-3).every((t) => t === lastRep) && !said(/call back another time/)) return turn({ action: "hang_up", say: "It sounds like we're going in circles, so I'll call back another time. Thank you for your help." });
  const low = lastRep.toLowerCase();

  if (/\b(have a (great|good|nice) day|goodbye|bye now)\b/.test(low) && !/\?/.test(lastRep)) return turn({ action: "hang_up", say: "" });
  if (said(/pass for now/) && !/\b(offer|apply)\b/.test(low)) return turn({ action: "hang_up", say: "That's all for today. Thank you for your time." });
  if (/\b(loyalty|retention) team\b/.test(low) && /\b(what can i do|how can i help|keep you)\b/.test(low) && agentLines.length > 1) {
    const have = best ? ` The best offer so far is ${describe(best)}.` : "";
    return turn({ say: `Thanks. ${first} pays $${d.monthly} a month for ${d.plan || "the plan"}.${have}${target != null ? ` We're hoping to get to about $${target} a month.` : ""} What can you do?` });
  }
  if (/\b(one moment|bear with me|let me (check|look|see|pull)|please hold|transfer you)\b/.test(low) && !/\?\s*$/.test(lastRep) && !parseOffer(lastRep)) return turn({ action: "wait" });

  if (!said(/\bAI assistant\b/)) {
    const greet = repName ? `Hi ${repName}, ` : "Hi, ";
    const disclose = `${greet}I'm an AI assistant calling on behalf of ${d.holder}, who has authorized me to discuss the account. This call is recorded.`;
    if (/\bname\b/.test(low)) return turn({ say: `${disclose} The name on the account is ${d.holder}.` });
    return turn({ say: `${disclose} ${purpose(d, first)}` });
  }

  if (/\b(authori[sz]e|confirm they)\b/.test(low) && /\?/.test(lastRep)) return turn({ action: "ask_user", say: "Sure, one moment while I check with them.", question: `The rep wants ${first} to confirm you authorize this call and changes to the account. Reply "I authorize" to confirm.` });

  for (const [re, key, label] of ASK_SECRET) {
    if (re.test(low) && /\?|can i (get|have)|i'?ll need/.test(low)) {
      if (d.available.includes(key)) return turn({ say: /doesn'?t match|again/.test(low) ? `Let me repeat that. It's ${key}.` : `Sure, it's ${key}.` });
      return turn({ action: "ask_user", secret: true, say: "One moment while I check that.", question: `The rep is asking for ${label}. It's not saved for this account.` });
    }
  }
  if (/\b(full )?name\b/.test(low) && /\?|i'?ll need/.test(low) && !/\b(rep|my) name\b/.test(low)) return turn({ say: `The name on the account is ${d.holder}.` });
  if (/\baddress\b/.test(low) && /\?/.test(lastRep)) return turn({ say: d.available.includes("{{address}}") ? "The service address is {{address}}." : "I don't have the address in front of me, but I can verify another way." });

  if (/scheduled the disconnect/.test(low) && best && !said(/rather than disconnect/)) return turn({ say: `Actually, rather than disconnect, ${first} will take ${describe(best)}. Please apply that instead.`, offer: best, decision: "accept" });
  if (/\banything else\b/.test(low)) {
    const conf = repLines.some((t) => /confirmation|reference/i.test(t));
    if (!conf) return turn({ say: "Could I get a confirmation number and your name for our records?" });
    const accepted = lastOffer && agentLines.length && said(/apply|accept|go ahead|works for/i);
    const recap = accepted && lastOffer ? ` Just to confirm, that's ${describe(lastOffer)}.` : "";
    return turn({ say: `No, that's everything.${recap} Thank you${repName ? `, ${repName}` : ""}, have a great day.` });
  }

  if (/would you like me to transfer|want me to transfer/.test(low)) return turn({ say: "Yes please, transfer me to loyalty." });

  const offer = parseOffer(lastRep);
  if (offer && /\?|would you like|i can (offer|do)|how does that sound/i.test(lastRep) && !(said(/will take/) && best && offer === lastOffer && /apply/.test(low))) return evaluate(d, offer, said, ctx);
  if (/would you like to keep the current offer/.test(low) && lastOffer) {
    const push = leverage(d, lastOffer, said, ctx, "I understand.");
    if (push.decision === "counter") return push;
    if (withinLimits(d.kind, lastOffer, d.limits, d.monthly).ok) return turn({ say: "Yes, please apply that one.", offer: lastOffer, decision: "accept" });
    return turn({ say: "No thank you. That's still more than we can do.", offer: lastOffer, decision: "decline" });
  }
  if (/don'?t see any promotions|standard rate|best i('m| am) able|lowest i can|no promotions/.test(low)) return leverage(d, lastOffer, said, ctx, "I understand.");
  if (/\b(how (can|may) i help|what can i (do|help)|help you with|what would you like to do|how can i help with)\b/.test(low)) {
    if ((lastOffer || said(/what promotions/i)) && d.kind === "lower") return leverage(d, lastOffer, said, ctx, "We're still hoping to lower the bill.");
    return turn({ say: purpose(d, first) });
  }
  if (/what charge/.test(low)) return turn({ say: `The charge of $${d.limits.refundAmount ?? ""} described here: ${d.details || "an incorrect charge"}.` });
  if (/\?\s*$/.test(lastRep)) return turn({ say: "Sorry, could you say that one more time?" });
  return turn({ action: "wait" });
}

function purpose(d: TurnData, first: string): string {
  if (d.kind === "cancel") return `${first} would like to cancel ${d.plan || "the service"}, effective today please.`;
  if (d.kind === "refund" || d.kind === "dispute") return `I'm calling about a charge${d.limits.refundAmount ? ` of $${d.limits.refundAmount}` : ""} on the account${d.details ? `: ${d.details}` : ""}. We'd like it refunded.`;
  return `${first} is paying $${d.monthly} a month for ${d.plan || "the current plan"}, which is more than they want to pay. What promotions does the account qualify for?`;
}

function describe(o: Offer): string {
  return describeOffer(o);
}

function evaluate(d: TurnData, offer: Offer, said: (re: RegExp) => boolean, ctx: Ctx): AgentTurn {
  const { first } = ctx;
  if (d.kind === "cancel") {
    if (withinLimits(d.kind, offer, d.limits, d.monthly).ok && d.limits.allowDowngrade) return turn({ say: "That works, please apply it.", offer, decision: "accept" });
    if (said(/still like to cancel/)) return turn({ say: "No thanks. Please go ahead and cancel it today.", offer, decision: "decline" });
    return turn({ say: `No thank you. ${first} would still like to cancel today.`, offer, decision: "decline" });
  }
  if (atTarget(d.kind, offer, d.limits, d.monthly)) return turn({ say: `That works for ${first}. Please go ahead and apply it.`, offer, decision: "accept" });
  const out = leverage(d, offer, said, ctx, "Thanks for looking.");
  if (out.decision === "decline" && withinLimits(d.kind, offer, d.limits, d.monthly).ok) return turn({ say: `Okay, that works. Please apply it.`, offer, decision: "accept" });
  return { ...out, offer };
}

function leverage(d: TurnData, offer: Offer | null, said: (re: RegExp) => boolean, ctx: Ctx, lead: string): AgentTurn {
  const { first, target, best } = ctx;
  const want = target != null ? ` ${first} is hoping to get to about $${target} a month.` : "";
  if (d.kind === "refund" || d.kind === "dispute") {
    if (!said(/full amount|supervisor/)) return turn({ say: `${lead} That charge shouldn't have happened, so we're asking for the full $${d.limits.refundAmount ?? ""}. Could you check with a supervisor?`, offer, decision: "counter" });
    return turn({ say: `${lead} We'll accept that for now.`, offer, decision: offer ? "accept" : "none" });
  }
  const comp = d.competitors.find((c) => !said(new RegExp(c.name.split(" ")[0], "i")));
  if (comp && !said(/offering/)) return turn({ say: `${lead} ${comp.name} is offering ${comp.offer} at the same address.${want} Can you match that?`, offer, decision: offer ? "counter" : "none" });
  if (!said(/loyalty|retention/)) return turn({ say: `${lead} That's still more than ${first} wants to pay. Could you transfer me to the loyalty or retention team?`, offer, decision: offer ? "counter" : "none" });
  if (d.limits.allowCancel && !said(/ready to cancel/)) return turn({ say: `${lead} Honestly, ${first} is ready to cancel today if we can't get closer.${want}`, offer, decision: offer ? "counter" : "none" });
  if (d.limits.allowCancel && !best && !said(/go ahead and schedule|schedule the disconnect/)) return turn({ say: "Then please go ahead and schedule the disconnect. Can you do better than that, or is that the lowest?", offer, decision: "decline" });
  if (best) return turn({ say: `${lead} In that case ${first} will take ${describe(best)}. Please go ahead and apply that.`, offer: best, decision: "accept" });
  return turn({ say: `${lead} That's above what ${first} can do, so we'll pass for now.`, offer, decision: "decline" });
}

export function rehearsalIvr(d: IvrData): { action: "press" | "say" | "wait"; digits: string; say: string } {
  const pick = chooseDigit(d.items, d.kind, d.tried);
  if (pick) return { action: "press", digits: pick.digit, say: "" };
  if (!d.items.length) return { action: "say", digits: "", say: speechIntent(d.kind) };
  return { action: "press", digits: "0", say: "" };
}

export class RehearsalBrain implements Brain {
  readonly name = "rehearsal";

  async stream(req: BrainRequest, onText: (text: string) => void): Promise<string> {
    const text = typeof req.data === "string" ? req.data : "Rehearsal mode has no model connected. Add an Anthropic key in Settings for written drafts.";
    for (const chunk of text.match(/[\s\S]{1,40}/g) ?? []) onText(chunk);
    return text;
  }

  async json<T>(req: BrainRequest): Promise<T> {
    if (req.task === "turn") return rehearsalTurn(req.data as TurnData) as T;
    if (req.task === "ivr") return rehearsalIvr(req.data as IvrData) as T;
    const d = req.data as { fallback?: unknown };
    if (d && "fallback" in d) return d.fallback as T;
    throw new Error(`rehearsal brain has no answer for ${req.task}`);
  }
}
