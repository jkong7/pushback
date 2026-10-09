import type { Account, Case, Limits } from "../src/engine/types.ts";
import { BUILTIN_MERCHANTS } from "../src/engine/merchants.ts";

export const merchant = (id: string) => BUILTIN_MERCHANTS.find((m) => m.id === id)!;

export function account(over: Partial<Account> = {}): Account {
  return {
    id: "acct-1",
    merchantId: "xfinity",
    label: "Home internet",
    holder: "Jordan Lee",
    accountNumber: "8495 1234 5678 9012",
    address: "742 Evergreen Terrace, Springfield",
    phoneOnFile: "+15555550142",
    plan: "Gigabit internet",
    monthly: 105,
    promoEnds: "2026-09-01",
    notes: "",
    secrets: { last4: "4821", pin: "7316" },
    createdAt: 0,
    ...over,
  };
}

export function limits(over: Partial<Limits> = {}): Limits {
  return { targetMonthly: 60, maxMonthly: 75, maxContractMonths: 12, allowCancel: true, allowDowngrade: false, refundAmount: null, minRefund: null, autoAccept: true, ...over };
}

export function kase(over: Partial<Case> = {}): Case {
  return { id: "case-1", accountId: "acct-1", kind: "lower", goal: "Lower the internet bill", details: "", limits: limits(), status: "ready", plan: null, createdAt: 0, updatedAt: 0, ...over };
}

export const FAST = { debounceMs: 5, menuMs: 5, needTimeoutMs: 2000, maxHoldMs: 60000, maxTurns: 40, silenceMs: 400 };
