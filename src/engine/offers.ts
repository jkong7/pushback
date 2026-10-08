import type { CaseKind, Limits, Offer } from "./types.ts";

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, nine: 9, twelve: 12, eighteen: 18, "twenty-four": 24, "twenty four": 24, "thirty-six": 36 };

const toNum = (s: string) => Number(s.replace(/,/g, ""));

export function parseOffer(text: string): Offer | null {
  const t = text.toLowerCase();
  const monthlyM =
    t.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:a|per|\/)\s*(?:month|mo)\b/) ??
    t.match(/(?:rate|price|bill|total|promo|plan) (?:of|to|at|is|would be|down to) \$\s?(\d[\d,]*(?:\.\d{1,2})?)/) ??
    t.match(/\bat \$\s?(\d[\d,]*(?:\.\d{1,2})?) for (?:\d{1,2}|one|two|three|six|twelve|twenty[- ]four) months/);
  const offM = t.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:monthly )?(?:off|discount|loyalty credit|monthly credit|credit)\b(?! of)/);
  const monthsM = t.match(/for (\d{1,2}|one|two|three|four|six|nine|twelve|eighteen|twenty[- ]four|thirty-six) (?:more )?months?/) ?? t.match(/(\d{1,2})[- ]month (?:promo|term|contract|agreement)/);
  const creditM = t.match(/(?:one[- ]time |courtesy |statement )?(?:credit|refund) (?:of|for) (?:the (?:full )?(?:amount of )?)?\$\s?(\d[\d,]*(?:\.\d{1,2})?)/) ?? t.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?) (?:one[- ]time |courtesy )?(?:credit|refund)\b/);
  const free = t.match(/\b(\d{1,2}|one|two|three|four|six|twelve) (?:free )?months?(?: free| at no charge)/);
  if (!monthlyM && !offM && !creditM && !free && !/\bwaive|waived\b/.test(t)) return null;
  const months = monthsM ? (NUM_WORDS[monthsM[1]] ?? toNum(monthsM[1])) : free ? (NUM_WORDS[free[1]] ?? (Number(free[1]) || null)) : null;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const sentence = sentences.find((s) => /\b(offer|apply|give you|can do)\b/i.test(s) && /\$|free|waive|credit|refund/i.test(s)) ?? sentences.find((s) => /\$|free|waive|credit|refund/i.test(s)) ?? text;
  return {
    monthly: monthlyM ? toNum(monthlyM[1]) : null,
    months,
    credit: creditM ? toNum(creditM[1]) : null,
    description: sentence.trim().slice(0, 200) + (offM && !monthlyM ? ` ($${toNum(offM[1])} off)` : ""),
  };
}

export function describeOffer(o: Offer, current?: number): string {
  const m = current != null ? effectiveMonthly(o, current) : o.monthly;
  const parts: string[] = [];
  if (m != null) parts.push(`$${m} a month${o.months ? ` for ${o.months} months` : ""}`);
  if (o.credit) parts.push(`a $${o.credit} credit`);
  if (!parts.length) return o.description.replace(/^(I can (offer|do|give) you|Let me[^.]*\.)\s*/i, "").replace(/[.?]+$/, "");
  return parts.join(" plus ");
}

export function effectiveMonthly(offer: Offer, current: number): number | null {
  if (offer.monthly != null) return offer.monthly;
  const off = offer.description.match(/\(\$(\d+(?:\.\d+)?) off\)/);
  if (off) return current - Number(off[1]);
  return null;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export function withinLimits(kind: CaseKind, offer: Offer, limits: Limits, current: number): Verdict {
  if (kind === "refund" || kind === "dispute") {
    const amt = offer.credit ?? 0;
    if (limits.minRefund != null && amt < limits.minRefund) return { ok: false, reason: `$${amt} is below your minimum of $${limits.minRefund}` };
    return { ok: true };
  }
  if (kind === "cancel") {
    const m = effectiveMonthly(offer, current);
    if (m === 0 || /free|waive/i.test(offer.description)) return { ok: true };
    if (limits.allowDowngrade && m != null && limits.maxMonthly != null && m <= limits.maxMonthly) return { ok: true };
    return { ok: false, reason: "you asked to cancel, not keep the service" };
  }
  const m = effectiveMonthly(offer, current);
  if (m == null) return { ok: false, reason: "the offer has no clear monthly price" };
  const cap = limits.maxMonthly ?? limits.targetMonthly;
  if (cap != null && m > cap) return { ok: false, reason: `$${m} a month is above your limit of $${cap}` };
  if (offer.months != null && limits.maxContractMonths >= 0 && /contract|agreement|commit/i.test(offer.description) && !/no (annual )?contract/i.test(offer.description) && offer.months > limits.maxContractMonths)
    return { ok: false, reason: `${offer.months} month contract is longer than your limit of ${limits.maxContractMonths}` };
  if (m >= current) return { ok: false, reason: "it doesn't lower the bill" };
  return { ok: true };
}

export function atTarget(kind: CaseKind, offer: Offer, limits: Limits, current: number): boolean {
  if (kind === "lower") {
    const m = effectiveMonthly(offer, current);
    return m != null && limits.targetMonthly != null && m <= limits.targetMonthly;
  }
  if (kind === "refund" || kind === "dispute") return (offer.credit ?? 0) >= (limits.refundAmount ?? Infinity);
  return withinLimits(kind, offer, limits, current).ok;
}

export function yearlySavings(oldMonthly: number | null, newMonthly: number | null, months: number | null, credit = 0): number {
  if (oldMonthly == null || newMonthly == null) return credit;
  return Math.max(0, (oldMonthly - newMonthly) * Math.min(12, months ?? 12)) + credit;
}
