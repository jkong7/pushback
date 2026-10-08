import type { Account, Case, Lesson, Limits, Merchant } from "./types.ts";
import { PLACEHOLDERS, maskAccountNumber } from "./vault.ts";

export const AGENT_SYSTEM = `You are Pushback, an AI assistant on a live phone call with a company's customer service rep, acting for the account holder. Your words are converted to speech, so write exactly what you would say out loud.

How you talk
- One or two short sentences per turn. Plain, friendly, calm, firm. No lists, no markdown, no emojis, no dashes as punctuation.
- Never pretend to be the account holder or a human. At your first turn with a human, say you are an AI assistant calling on behalf of the holder (by name), that they authorized you to discuss the account, and that the call is recorded.
- If the rep asks whether you are a bot or AI, say yes, plainly.

Secrets
- You never see the holder's PIN, SSN digits, security answers, date of birth or full account number. When the rep asks for one, speak its placeholder exactly, for example "Sure, the PIN is {{pin}}." The app fills it in after you write it.
- Only use placeholders listed as available. If the rep needs something not available, use action "ask_user" with a short question for the holder, and in "say" tell the rep "One moment while I check that."
- Never invent facts about the account, the holder, competitor offers or past calls. Use only what the context gives you.

Negotiating
- Follow the plan and tactics. Ask what promotions the account qualifies for, cite the competitor offers you were given, ask for the retention or loyalty department when the front line can't help, and be willing to say the holder is ready to cancel only if cancelling is allowed.
- Whenever the rep states an offer, fill "offer" with its numbers and set "decision". Accept only offers inside the holder's limits. Counter when the offer is above target but you have leverage left. Decline politely when it is outside the limits and nothing is left to try.
- Before accepting, confirm the new monthly total with taxes and fees, how long it lasts, and whether there is a contract.
- Before ending, get a confirmation or reference number and the rep's name, and repeat back what was agreed. Then thank them and use action "hang_up".

Actions
- "say": speak the text in "say".
- "press": press keypad digits in "digits" (only if a human rep explicitly asks you to press something).
- "wait": say nothing (the rep is still talking, is looking something up, or asked you to hold).
- "ask_user": you need something only the holder can give, or an offer needs their approval. Put the question in "question". Set "secret" true when the answer is sensitive.
- "hang_up": the call is finished.`;

export const IVR_SYSTEM = `You are navigating an automated phone menu for a customer. Pick the option most likely to reach a human who can handle the goal. For lowering a bill or cancelling, cancellation or retention options reach the department with the most authority. Avoid technical support, sales for new service and automated payments. Return the digit to press, or words to say if the menu asks for speech, or wait if the menu has not finished.`;

export const REP_SYSTEM = `You play a customer service rep at a company, in a training simulator for a negotiating assistant. Stay realistic: follow company policy, verify identity before discussing the account, resist discounts at first, transfer to the retention or loyalty team when the caller is firm about cancelling, and only offer what your offer ladder allows in order. Never offer anything better than the ladder. Keep each turn to one to three spoken sentences.`;

export const PLAN_SYSTEM = `You prepare a negotiation plan for an AI that will phone a company on a customer's behalf. Be concrete: the opening line, the steps in order, the leverage to use (only the competitor offers and facts given), what to ask for, fallbacks if the rep won't move, and anything still missing that the customer must provide before calling (only items the merchant actually verifies and the account doesn't have). Keep each item to one sentence. Don't invent prices.`;

export const OUTCOME_SYSTEM = `You read a finished customer service call transcript and record what happened, factually. Only record numbers and promises the rep actually stated. If something was not said, use null. Promises are anything the company committed to do later (credits, callbacks, equipment returns, confirmation emails), with a due date if one was given (YYYY-MM-DD, resolved against the call date). Lessons are short, reusable notes about this merchant for next time (which phone menu path worked, what unlocked the offer, what failed).`;

export const LETTER_SYSTEM = `You draft a short letter or email that the customer will review and send themselves. Plain, firm, factual, first person as the customer. Include the account details given, the dates, the confirmation numbers and the exact request. No legal threats beyond what is true and proportionate. No dashes as punctuation. Start with "Subject: " on the first line.`;

export const BILL_SYSTEM = `You read a bill or statement and extract the account details. Use null for anything not shown. Money amounts are numbers without currency symbols. Dates are YYYY-MM-DD.`;

const money = (n: number | null | undefined) => (n == null ? "none" : `$${n.toFixed(2)}`);

export function limitsText(kind: Case["kind"], l: Limits): string {
  const lines: string[] = [];
  if (kind === "lower") {
    lines.push(`Target monthly price: ${money(l.targetMonthly)}`);
    lines.push(`Highest acceptable monthly price: ${money(l.maxMonthly)}`);
    lines.push(`Longest acceptable contract: ${l.maxContractMonths ? `${l.maxContractMonths} months` : "no contract"}`);
    lines.push(`Downgrading speed or features: ${l.allowDowngrade ? "allowed" : "not allowed"}`);
    lines.push(`Cancelling if no deal: ${l.allowCancel ? "allowed, the holder is willing to cancel" : "not allowed, do not cancel and do not bluff about a date"}`);
  }
  if (kind === "cancel") {
    lines.push("Goal: cancel. Decline retention offers unless they make the service free.");
    lines.push(`Accept a retention offer instead of cancelling: ${l.allowDowngrade ? `only at or below ${money(l.maxMonthly)} a month` : "no"}`);
  }
  if (kind === "refund" || kind === "dispute") {
    lines.push(`Amount to get back: ${money(l.refundAmount)}`);
    lines.push(`Lowest acceptable credit or refund: ${money(l.minRefund)}`);
  }
  lines.push(`Accept offers inside these limits without asking: ${l.autoAccept ? "yes" : "no, ask the holder first"}`);
  return lines.join("\n");
}

export function caseContext(c: Case, a: Account, m: Merchant, lessons: Lesson[], available: string[]): string {
  const plan = c.plan
    ? [`Opener: ${c.plan.opener}`, "Steps:", ...c.plan.steps.map((s) => `- ${s}`), "Leverage:", ...c.plan.leverage.map((s) => `- ${s}`), "Asks:", ...c.plan.asks.map((s) => `- ${s}`), "Fallbacks:", ...c.plan.fallbacks.map((s) => `- ${s}`)].join("\n")
    : "No plan yet. Use the tactics.";
  return [
    `CALLING: ${m.name}`,
    `GOAL (${c.kind}): ${c.goal}`,
    c.details ? `DETAILS: ${c.details}` : "",
    "",
    "ACCOUNT",
    `Holder: ${a.holder}`,
    `Account number: ${maskAccountNumber(a.accountNumber)}`,
    `Current plan: ${a.plan || "unknown"}`,
    `Current monthly price: ${money(a.monthly)}`,
    a.promoEnds ? `Current promo ends: ${a.promoEnds}` : "",
    a.notes ? `Notes: ${a.notes}` : "",
    "",
    "LIMITS",
    limitsText(c.kind, c.limits),
    "",
    "AVAILABLE PLACEHOLDERS",
    available.length ? available.map((k) => `${k}: ${PLACEHOLDERS[k] ?? "provided by the holder"}`).join("\n") : "none",
    "",
    "WHAT THIS MERCHANT VERIFIES",
    m.verification.map((v) => `- ${v}`).join("\n"),
    "",
    "TACTICS",
    m.tactics.map((t) => `- ${t}`).join("\n"),
    m.competitors.length ? `\nCOMPETITOR OFFERS\n${m.competitors.map((x) => `- ${x.name}: ${x.offer}`).join("\n")}` : "",
    lessons.length ? `\nWHAT HAPPENED ON PAST CALLS\n${lessons.slice(0, 12).map((l) => `- ${l.text}`).join("\n")}` : "",
    "",
    "PLAN",
    plan,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

export function transcriptText(lines: { who: string; text: string }[], max = 40): string {
  return lines.slice(-max).map((l) => `${l.who}: ${l.text}`).join("\n");
}

const nullable = (type: string) => ({ anyOf: [{ type }, { type: "null" }] });

export const TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "say", "digits", "question", "secret", "offer", "decision", "note"],
  properties: {
    action: { type: "string", enum: ["say", "press", "wait", "ask_user", "hang_up"] },
    say: { type: "string" },
    digits: { type: "string" },
    question: { type: "string" },
    secret: { type: "boolean" },
    offer: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["monthly", "months", "credit", "description"],
          properties: { monthly: nullable("number"), months: nullable("integer"), credit: nullable("number"), description: { type: "string" } },
        },
      ],
    },
    decision: { type: "string", enum: ["accept", "counter", "decline", "none"] },
    note: { type: "string" },
  },
};

export const IVR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "digits", "say"],
  properties: { action: { type: "string", enum: ["press", "say", "wait"] }, digits: { type: "string" }, say: { type: "string" } },
};

export const REP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["say", "transfer", "end"],
  properties: { say: { type: "string" }, transfer: { type: "string", enum: ["none", "retention", "supervisor", "hold"] }, end: { type: "boolean" } },
};

const strings = { type: "array", items: { type: "string" } };

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["opener", "steps", "leverage", "asks", "fallbacks", "missing", "risk"],
  properties: {
    opener: { type: "string" },
    steps: strings,
    leverage: strings,
    asks: strings,
    fallbacks: strings,
    missing: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "label"], properties: { key: { type: "string" }, label: { type: "string" } } } },
    risk: { type: "string" },
  },
};

export const OUTCOME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["result", "summary", "oldMonthly", "newMonthly", "months", "credit", "promoEnds", "confirmation", "repName", "promises", "nextSteps", "lessons"],
  properties: {
    result: { type: "string", enum: ["won", "partial", "lost", "cancelled", "refunded", "no-answer"] },
    summary: { type: "string" },
    oldMonthly: nullable("number"),
    newMonthly: nullable("number"),
    months: nullable("integer"),
    credit: { type: "number" },
    promoEnds: nullable("string"),
    confirmation: nullable("string"),
    repName: nullable("string"),
    promises: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "due"], properties: { text: { type: "string" }, due: nullable("string") } } },
    nextSteps: strings,
    lessons: strings,
  },
};

export const BILL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["merchant", "holder", "accountNumber", "address", "plan", "monthly", "promoEnds", "fees", "dueDate"],
  properties: {
    merchant: nullable("string"),
    holder: nullable("string"),
    accountNumber: nullable("string"),
    address: nullable("string"),
    plan: nullable("string"),
    monthly: nullable("number"),
    promoEnds: nullable("string"),
    fees: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "amount"], properties: { label: { type: "string" }, amount: { type: "number" } } } },
    dueDate: nullable("string"),
  },
};
