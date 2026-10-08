import type { Account, Case, Commitment, Outcome, Reminder } from "./types.ts";
import { parseOffer } from "./offers.ts";
import { randomUUID } from "node:crypto";

export interface Line {
  who: string;
  text: string;
}

const DAY = 86400000;

function collapseDigits(s: string): string {
  return s.replace(/\b([A-Z0-9])((?: [A-Z0-9]\b){3,})/g, (m) => m.replace(/ /g, ""));
}

export function extractOutcome(kase: Case, account: Account, lines: Line[], startedAt: number): Outcome {
  const rep = lines.filter((l) => l.who === "REP").map((l) => collapseDigits(l.text));
  const agent = lines.filter((l) => l.who === "AGENT").map((l) => l.text);
  const all = rep.join(" ");
  const humanReached = rep.some((t) => /\b(my name is|this is|loyalty team|how can I help)\b/i.test(t));
  const conf = all.match(/\b(?:confirmation|reference|cancellation confirmation) (?:number|code|#)? ?(?:is )?([A-Z]{0,4}\d{4,}[A-Z0-9]*)/i)?.[1] ?? null;
  const repName = [...all.matchAll(/\b(?:my name is|this is) ([A-Z][a-z]+)/g)].map((m) => m[1]).filter((n) => !["Pushback"].includes(n)).at(-1) ?? null;
  const applied = rep.findIndex((t) => /\b(I've applied|I have applied|applied that|I've issued|I've cancelled|I've processed)\b/i.test(t));
  let accepted = null as ReturnType<typeof parseOffer>;
  if (applied >= 0) {
    accepted = parseOffer(rep[applied]);
    for (let i = applied - 1; i >= 0 && (!accepted || accepted.monthly == null) && kase.kind === "lower"; i--) {
      const o = parseOffer(rep[i]);
      if (o) accepted = { ...o, ...(accepted ?? {}), monthly: accepted?.monthly ?? o.monthly, months: accepted?.months ?? o.months } as typeof o;
    }
  }
  const promoEnds = all.match(/ending (\d{4}-\d{2}-\d{2})/)?.[1] ?? (accepted?.months ? new Date(startedAt + accepted.months * 30.4 * DAY).toISOString().slice(0, 10) : null);
  const promises: Commitment[] = [];
  const due = (days: number) => new Date(startedAt + days * DAY).toISOString().slice(0, 10);
  if (/show on your next statement|one to two billing cycles|next bill/i.test(all) && /credit/i.test(all)) promises.push({ text: "Credit appears on the statement within one to two billing cycles", due: due(62) });
  if (/starting next bill/i.test(all) && accepted?.monthly != null) promises.push({ text: `New rate of $${accepted.monthly} a month shows on the next bill`, due: due(35) });
  if (/get an email|confirmation email|email confirming/i.test(all)) promises.push({ text: "Confirmation email from the company", due: due(2) });
  const ret = all.match(/return (?:the )?equipment within (\d+) days/i);
  if (ret) promises.push({ text: `Return equipment within ${ret[1]} days and keep the receipt`, due: due(Number(ret[1])) });
  if (/won'?t be billed again/i.test(all)) promises.push({ text: "No further charges after cancellation", due: due(35) });
  const disconnect = /scheduled the disconnect/i.test(all);
  if (disconnect) promises.push({ text: "Disconnect scheduled; watch for a callback with a better offer before it happens", due: due(10) });

  let result: Outcome["result"] = "lost";
  let newMonthly: number | null = null;
  let credit = 0;
  if (!humanReached) result = "no-answer";
  else if (kase.kind === "cancel" && /\b(cancelled the service|cancelled your|processed the cancellation|won'?t be billed again)\b/i.test(all)) {
    result = "cancelled";
    newMonthly = 0;
  } else if ((kase.kind === "refund" || kase.kind === "dispute") && applied >= 0 && accepted?.credit) {
    credit = accepted.credit;
    result = kase.limits.refundAmount != null && credit < kase.limits.refundAmount ? "partial" : "refunded";
  } else if (applied >= 0 && accepted) {
    newMonthly = accepted.monthly ?? null;
    if (kase.kind === "cancel") result = "partial";
    else result = newMonthly != null && kase.limits.targetMonthly != null && newMonthly > kase.limits.targetMonthly ? "partial" : "won";
    credit = accepted.credit ?? 0;
  } else if (disconnect) result = "partial";

  const saved = newMonthly != null ? account.monthly - newMonthly : 0;
  const summary =
    result === "no-answer"
      ? "Didn't reach a person."
      : result === "cancelled"
        ? `Cancelled ${account.plan || "the service"}${conf ? `, confirmation ${conf}` : ""}.`
        : result === "refunded" || (result === "partial" && credit)
          ? `Got a $${credit} credit${conf ? `, reference ${conf}` : ""}.`
          : newMonthly != null
            ? `Lowered from $${account.monthly} to $${newMonthly} a month${accepted?.months ? ` for ${accepted.months} months` : ""} ($${saved.toFixed(0)} a month less).`
            : disconnect
              ? "No offer good enough; disconnect scheduled so retention can call back."
              : "No offer inside your limits.";
  const lessons: string[] = [];
  const pressed = lines.filter((l) => l.who === "KEYPAD").map((l) => l.text.replace(/\D/g, "")).join(" then ");
  if (pressed && humanReached) lessons.push(`Phone menu path that reached a person: ${pressed}`);
  const unlockIdx = rep.findIndex((t) => /transfer you to (our |the )?(loyalty|retention)/i.test(t));
  if (unlockIdx >= 0) lessons.push("Asking for loyalty or mentioning cancelling got a transfer to the loyalty team");
  if (applied >= 0 && agent.some((t) => /offering|competitor/i.test(t))) lessons.push("Quoting a competitor price moved the offer");
  const verifyFailed = /not able to verify/i.test(all);
  if (verifyFailed) lessons.push("Verification failed; save the PIN and security details before calling");
  else if (result === "lost" && humanReached && !rep.some((t) => parseOffer(t))) lessons.push("No offers came up; ask for retention sooner next time");
  return {
    result,
    summary,
    oldMonthly: account.monthly,
    newMonthly,
    months: accepted?.months ?? null,
    credit,
    promoEnds: result === "won" || result === "partial" ? promoEnds : null,
    confirmation: conf,
    repName,
    promises,
    nextSteps: nextSteps(result, kase),
    lessons,
  };
}

function nextSteps(result: Outcome["result"], kase: Case): string[] {
  if (result === "no-answer") return ["Try again during business hours"];
  if (result === "lost") return kase.limits.allowCancel ? ["Call back and ask for retention directly", "Or schedule a disconnect and wait for the callback offer"] : ["Call back in a few weeks; offers change"];
  if (result === "cancelled") return ["Check the next statement has no charge", "Return any equipment and keep the receipt"];
  return ["Check the next bill shows the new amount"];
}

export function remindersFor(kase: Case, account: Account, outcome: Outcome, now = Date.now()): Reminder[] {
  const out: Reminder[] = [];
  const add = (due: number, kind: Reminder["kind"], text: string) => out.push({ id: randomUUID(), caseId: kase.id, accountId: account.id, due, kind, text, done: false });
  if (outcome.promoEnds) add(Date.parse(outcome.promoEnds) - 21 * DAY, "promo", `Promo at ${account.label} ends ${outcome.promoEnds}. Call before the price goes back up.`);
  for (const p of outcome.promises) if (p.due) add(Date.parse(p.due), /credit|rate|charges/i.test(p.text) ? (/charges/.test(p.text) ? "cancel-check" : "credit") : "follow-up", `${account.label}: ${p.text}`);
  if (outcome.result === "no-answer" || outcome.result === "lost") add(now + (outcome.result === "lost" ? 14 : 1) * DAY, "follow-up", `${account.label}: try again${outcome.result === "lost" ? ", offers change every few weeks" : ""}`);
  return out;
}
