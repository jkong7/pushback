import type { Account, Brain, Case, Lesson, Merchant, Plan, Secret } from "./types.ts";
import { SECRET_LABELS } from "./types.ts";
import { PLAN_SCHEMA, PLAN_SYSTEM, caseContext } from "./prompts.ts";

const VERIFY_MAP: [RegExp, Secret][] = [
  [/\bpin\b|passcode/i, "pin"],
  [/ssn|social/i, "last4"],
  [/security question/i, "security"],
  [/date of birth|dob/i, "dob"],
];

export function missingInfo(account: Account, merchant: Merchant): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const needs = new Set<Secret>(merchant.sim.requires);
  for (const v of merchant.verification) for (const [re, k] of VERIFY_MAP) if (re.test(v) && !/ or /i.test(v)) needs.add(k);
  const either = merchant.verification.find((v) => / or /i.test(v) && VERIFY_MAP.some(([re]) => re.test(v)));
  if (either) {
    const ks = VERIFY_MAP.filter(([re]) => re.test(either)).map(([, k]) => k);
    if (!ks.some((k) => account.secrets[k])) needs.add(ks[0]);
  }
  for (const k of needs) if (!account.secrets[k]) out.push({ key: k, label: SECRET_LABELS[k] });
  if (!account.holder) out.unshift({ key: "holder", label: "Name on the account" });
  if (!account.accountNumber && merchant.verification.some((v) => /account (number|#)/i.test(v))) out.push({ key: "account_number", label: "Account number" });
  if (!account.address && merchant.verification.some((v) => /address/i.test(v))) out.push({ key: "address", label: "Service address" });
  return out;
}

export function templatePlan(kase: Case, account: Account, merchant: Merchant, lessons: Lesson[]): Plan {
  const first = account.holder.split(" ")[0] || "the holder";
  const l = kase.limits;
  const comp = merchant.competitors[0];
  const opener = `Hi, I'm an AI assistant calling on behalf of ${account.holder || "the account holder"}, who authorized me to discuss the account. This call is recorded.`;
  const steps: string[] = [];
  const leverage: string[] = [];
  const asks: string[] = [];
  const fallbacks: string[] = [];
  steps.push(`Phone menu: ${merchant.ivr[0] ?? "choose billing or cancellation"}`);
  steps.push("Verify with the details on file; never guess a PIN or security answer");
  if (kase.kind === "lower") {
    steps.push(`Explain the bill is $${account.monthly} a month and ask what promotions the account qualifies for`);
    if (comp) steps.push(`Quote ${comp.name} (${comp.offer}) and name the target of $${l.targetMonthly ?? "less"}`);
    steps.push("If billing can't move, ask for the loyalty or retention team");
    if (l.allowCancel) steps.push(`Say ${first} is ready to cancel today if the price doesn't get close to the target`);
    steps.push("Before accepting: total with taxes and fees, promo length, contract or not, confirmation number and rep name");
    for (const c of merchant.competitors) leverage.push(`${c.name}: ${c.offer}`);
    leverage.push(`Current price $${account.monthly}${account.promoEnds ? `, promo ended ${account.promoEnds}` : ""}`);
    asks.push(`$${l.targetMonthly ?? "lower"} a month or less`, `No contract longer than ${l.maxContractMonths} months`);
    if (l.allowDowngrade) asks.push("A cheaper tier if it covers what you use");
    fallbacks.push(l.allowCancel ? "Schedule a disconnect 10 days out and wait for the retention callback" : "Accept the best offer under your limit, or call back in a few weeks");
    fallbacks.push("Ask for a one-time bill credit if the monthly price won't move");
  } else if (kase.kind === "cancel") {
    steps.push(`Ask to cancel ${account.plan || "the service"} effective today`);
    steps.push("Decline retention offers politely unless they make it free");
    steps.push("Get a cancellation confirmation number, the last billing date and equipment return steps");
    asks.push("Cancellation effective today", "No further charges", "Confirmation number");
    fallbacks.push(merchant.cancel);
    if (merchant.written?.address || merchant.written?.email) fallbacks.push("Send a written cancellation letter");
  } else {
    steps.push(`Explain the charge${l.refundAmount ? ` of $${l.refundAmount}` : ""} and ask for it to be reversed`);
    steps.push("If offered a partial credit, ask for the full amount or a supervisor");
    steps.push("Get a reference number and when the credit will post");
    asks.push(`Refund of $${l.refundAmount ?? "the full charge"}`);
    fallbacks.push("Draft a written dispute", "Card chargeback if the merchant won't fix it");
  }
  for (const x of lessons.slice(0, 3)) steps.push(`From last time: ${x.text}`);
  return { opener, steps, leverage, asks, fallbacks, missing: missingInfo(account, merchant), risk: merchant.typicalWin ? `Typical result: ${merchant.typicalWin}` : "" };
}

export async function makePlan(brain: Brain, kase: Case, account: Account, merchant: Merchant, lessons: Lesson[], available: string[]): Promise<Plan> {
  const fallback = templatePlan(kase, account, merchant, lessons);
  if (brain.name !== "claude") return fallback;
  const plan = await brain.json<Plan>(
    { task: "plan", system: PLAN_SYSTEM, context: caseContext({ ...kase, plan: null }, account, merchant, lessons, available), prompt: "Write the plan for this call.", data: { fallback } },
    PLAN_SCHEMA,
  );
  const known = new Set(fallback.missing.map((m) => m.key));
  return { ...plan, missing: [...fallback.missing, ...plan.missing.filter((m) => !known.has(m.key) && !available.includes(`{{${m.key}}}`))] };
}
