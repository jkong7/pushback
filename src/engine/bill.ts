import type { Brain, Merchant } from "./types.ts";
import { BILL_SCHEMA, BILL_SYSTEM } from "./prompts.ts";

export interface BillFields {
  merchant: string | null;
  holder: string | null;
  accountNumber: string | null;
  address: string | null;
  plan: string | null;
  monthly: number | null;
  promoEnds: string | null;
  fees: { label: string; amount: number }[];
  dueDate: string | null;
}

const money = (s: string) => Number(s.replace(/[$,]/g, ""));

function isoDate(s: string): string | null {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : new Date(d).toISOString().slice(0, 10);
}

export function parseBillText(text: string, merchants: Merchant[]): BillFields {
  const lower = text.toLowerCase();
  const merchant = merchants.find((m) => [m.name, m.id, m.name.split(" (")[0]].some((n) => lower.includes(n.toLowerCase()))) ?? null;
  const field = (re: RegExp) => text.match(re)?.[1]?.trim() ?? null;
  const total = field(/(?:total (?:amount )?due|amount due|new charges|total this month|monthly (?:total|charges))[^$\d]{0,30}\$?\s?(\d[\d,]*\.\d{2})/i);
  const promo = field(/(?:promo(?:tion|tional)?(?: rate| pricing| discount)?|discount) (?:ends|expires|ending|through)(?: on)?\s*:?\s*([A-Za-z]{3,9} \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const due = field(/(?:payment )?due (?:date|by)\s*:?\s*([A-Za-z]{3,9} \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const fees: { label: string; amount: number }[] = [];
  for (const m of text.matchAll(/^\s*([A-Za-z][^\n$]*?(?:fee|surcharge|rental|equipment|recovery)[^\n$]*?)\s*\$?(\d+\.\d{2})\s*$/gim)) fees.push({ label: m[1].trim().replace(/[.\s]+$/, ""), amount: money(m[2]) });
  return {
    merchant: merchant?.name ?? field(/^\s*([A-Z][A-Za-z&. ]{2,30})\s*$/m),
    holder: field(/(?:[Aa]ccount [Hh]older|[Cc]ustomer [Nn]ame|[Nn]ame on [Aa]ccount|[Bb]ill [Tt]o)\s*:?\s*([A-Z][a-z]+(?: [A-Z][a-z.]+){1,2})/),
    accountNumber: field(/account (?:number|no\.?|#)\s*:?\s*([0-9][0-9 -]{5,24}[0-9])/i)?.replace(/\s+/g, " ") ?? null,
    address: field(/(?:service address|service location)\s*:?\s*([^\n]+)/i),
    plan: field(/(?:plan|package|service plan)\s*:\s*([^\n$]+?)(?:\s+\$|\n|$)/i),
    monthly: total ? money(total) : null,
    promoEnds: promo ? isoDate(promo) : null,
    fees,
    dueDate: due ? isoDate(due) : null,
  };
}

export async function readBill(brain: Brain, input: { text?: string; file?: { data: string; mediaType: "image/png" | "image/jpeg" | "application/pdf" } }, merchants: Merchant[]): Promise<BillFields> {
  const local = parseBillText(input.text ?? "", merchants);
  if (brain.name !== "claude") return local;
  const fields = await brain.json<BillFields>(
    { task: "bill", system: BILL_SYSTEM, context: `Known companies: ${merchants.map((m) => m.name).join(", ")}`, prompt: input.text ? `Bill text:\n${input.text}` : "Read this bill.", image: input.file, data: input },
    BILL_SCHEMA,
  );
  const known = merchants.find((m) => fields.merchant && [m.name, m.name.split(" (")[0]].some((n) => fields.merchant!.toLowerCase().includes(n.toLowerCase())));
  return { ...fields, merchant: known?.name ?? fields.merchant };
}

export function matchMerchant(name: string | null, merchants: Merchant[]): Merchant | null {
  if (!name) return null;
  const n = name.toLowerCase();
  return merchants.find((m) => [m.name, m.id, m.name.split(" (")[0]].some((x) => n.includes(x.toLowerCase()) || x.toLowerCase().includes(n))) ?? null;
}

export function feeSavings(fees: { label: string; amount: number }[]): { label: string; amount: number; tip: string }[] {
  return fees
    .filter((f) => /equipment|modem|router|gateway|rental/i.test(f.label))
    .map((f) => ({ ...f, tip: "Buying your own modem or router usually removes this fee" }));
}
