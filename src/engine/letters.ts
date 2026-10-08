import type { Account, Brain, Case, LetterKind, Merchant, Outcome } from "./types.ts";
import { LETTER_SYSTEM } from "./prompts.ts";
import { maskAccountNumber } from "./vault.ts";

export const LETTER_LABELS: Record<LetterKind, string> = {
  cancel: "Cancellation letter",
  complaint: "Regulator complaint",
  chargeback: "Card dispute",
  refund: "Refund request",
  "follow-up": "Follow-up",
};

export interface LetterInput {
  kind: LetterKind;
  kase: Case;
  account: Account;
  merchant: Merchant;
  outcome: Outcome | null;
  today?: string;
}

export function letterTo(kind: LetterKind, merchant: Merchant): string {
  if (kind === "complaint") return merchant.category === "internet" || merchant.category === "wireless" || merchant.category === "tv" ? "FCC consumer complaints (consumercomplaints.fcc.gov)" : "CFPB complaints (consumerfinance.gov/complaint) or your state attorney general";
  if (kind === "chargeback") return "Your card issuer (dispute form or secure message)";
  return merchant.written?.email ?? merchant.written?.address ?? merchant.written?.url ?? `${merchant.name} customer service`;
}

export function templateLetter(input: LetterInput): string {
  const { kind, kase, account, merchant, outcome } = input;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const acct = account.accountNumber ? `Account number: ${account.accountNumber}` : `Account ${maskAccountNumber(account.accountNumber)}`;
  const conf = outcome?.confirmation ? `Confirmation number from my call: ${outcome.confirmation}${outcome.repName ? ` (rep: ${outcome.repName})` : ""}.` : "";
  const sign = `\n\n${account.holder}\n${account.address}`.trimEnd();
  const header = `${acct}\nName on account: ${account.holder}\nService address: ${account.address || "on file"}\nDate: ${today}`;
  switch (kind) {
    case "cancel":
      return `Subject: Cancel my ${merchant.name} account effective immediately\n\nTo ${merchant.name},\n\n${header}\n\nPlease cancel my ${account.plan || "service"} effective ${today} and stop all future charges. ${conf} Please send written confirmation of the cancellation and the final billing date to me at the address above. If any equipment needs to be returned, tell me where and how.\n\nThank you.${sign}`;
    case "refund":
      return `Subject: Refund request for a charge on my account\n\nTo ${merchant.name},\n\n${header}\n\nI'm writing about ${kase.details || "a charge on my account"}. I'm asking for a refund of $${kase.limits.refundAmount ?? "the full amount"} to my original payment method. ${conf} Please confirm in writing when the refund has been issued.\n\nThank you.${sign}`;
    case "complaint":
      return `Subject: Complaint about ${merchant.name}\n\nCompany: ${merchant.name}\n${header}\n\nWhat happened: ${kase.details || kase.goal}. ${outcome ? `On my most recent call, ${outcome.summary.charAt(0).toLowerCase()}${outcome.summary.slice(1)}` : ""} ${conf}\n\nWhat I'm asking for: ${kase.goal}.\n\nI have tried to resolve this with the company directly and would like a written response.${sign}`;
    case "chargeback":
      return `Subject: Dispute of a charge from ${merchant.name}\n\nCardholder: ${account.holder}\nMerchant: ${merchant.name}\nDate: ${today}\n\nI'm disputing ${kase.details || "a charge from this merchant"} for $${kase.limits.refundAmount ?? "[amount]"}. I contacted the merchant to resolve it. ${conf || "They did not resolve it."} Please reverse the charge and send me the result in writing.${sign}`;
    default:
      return `Subject: Following up on my call with ${merchant.name}\n\nTo ${merchant.name},\n\n${header}\n\n${conf} On that call I was told: ${(outcome?.promises ?? []).map((p) => p.text.toLowerCase()).join("; ") || outcome?.summary || kase.goal}. This hasn't happened yet. Please make the change and confirm in writing.\n\nThank you.${sign}`;
  }
}

export async function draftLetter(brain: Brain, input: LetterInput, onText: (t: string) => void): Promise<string> {
  const template = templateLetter(input);
  if (brain.name !== "claude") {
    for (const chunk of template.match(/[\s\S]{1,40}/g) ?? []) onText(chunk);
    return template;
  }
  const { kase, account, merchant, outcome, kind } = input;
  const context = [
    `Letter type: ${LETTER_LABELS[kind]}`,
    `Recipient: ${letterTo(kind, merchant)}`,
    `Company: ${merchant.name}`,
    `Customer: ${account.holder}, ${account.address}`,
    `Account number: ${account.accountNumber || "unknown"}`,
    `Plan: ${account.plan}, $${account.monthly} a month`,
    `Case: ${kase.kind}, goal: ${kase.goal}. ${kase.details}`,
    outcome ? `Last call: ${outcome.summary} Confirmation: ${outcome.confirmation ?? "none"}. Rep: ${outcome.repName ?? "unknown"}. Promises: ${outcome.promises.map((p) => p.text).join("; ") || "none"}` : "No call yet.",
  ].join("\n");
  return brain.stream({ task: "letter", system: LETTER_SYSTEM, context, prompt: `Draft it. Today is ${input.today ?? new Date().toISOString().slice(0, 10)}. Structure reference:\n${template}`, data: input }, onText);
}

export function splitSubject(text: string): { subject: string; body: string } {
  const m = text.match(/^Subject:\s*(.+)\n+/);
  return m ? { subject: m[1].trim(), body: text.slice(m[0].length).trim() } : { subject: "", body: text.trim() };
}
