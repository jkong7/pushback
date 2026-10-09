import type { Store } from "../engine/store.ts";
import type { Limits } from "../engine/types.ts";
import { templatePlan } from "../engine/planner.ts";

const limits = (l: Partial<Limits>): Limits => ({ targetMonthly: null, maxMonthly: null, maxContractMonths: 12, allowCancel: false, allowDowngrade: false, refundAmount: null, minRefund: null, autoAccept: true, ...l });

export function seedDemo(store: Store) {
  const holder = "Jordan Lee";
  const address = "742 Evergreen Terrace, Springfield";
  const xfinity = store.saveAccount({ merchantId: "xfinity", label: "Home internet", holder, accountNumber: "8495 1234 5678 9012", address, phoneOnFile: "+15555550142", plan: "Gigabit internet", monthly: 105, promoEnds: "2026-09-01", notes: "Promo rolled off last month, bill jumped from $65.", secrets: { last4: "4821" } });
  const sirius = store.saveAccount({ merchantId: "siriusxm", label: "Car radio", holder, accountNumber: "SXM-55120-9", address, phoneOnFile: "+15555550142", plan: "Platinum", monthly: 22.99, promoEnds: null, notes: "Barely use it.", secrets: {} });
  const verizon = store.saveAccount({ merchantId: "verizon", label: "Phone plan", holder, accountNumber: "882104455-00001", address, phoneOnFile: "+15555550142", plan: "Unlimited Plus, one line", monthly: 90, promoEnds: null, notes: "", secrets: {} });
  const att = store.saveAccount({ merchantId: "att", label: "Parents' internet", holder, accountNumber: "171 555 2290", address, phoneOnFile: "+15555550142", plan: "Fiber 500", monthly: 80, promoEnds: null, notes: "Charged a $35 late fee even though autopay was on.", secrets: { pin: "2468" } });
  const cases = [
    { accountId: xfinity.id, kind: "lower" as const, goal: "Get the internet bill back near the old promo price", details: "Customer since 2021. Promo ended Sep 1.", limits: limits({ targetMonthly: 60, maxMonthly: 75, allowCancel: true }) },
    { accountId: sirius.id, kind: "cancel" as const, goal: "Cancel SiriusXM", details: "", limits: limits({}) },
    { accountId: verizon.id, kind: "lower" as const, goal: "Lower the phone bill", details: "", limits: limits({ targetMonthly: 70, maxMonthly: 80, autoAccept: false }) },
    { accountId: att.id, kind: "refund" as const, goal: "Get the late fee refunded", details: "a $35 late fee on the September bill while autopay was on", limits: limits({ refundAmount: 35, minRefund: 20 }) },
  ];
  for (const c of cases) {
    const account = store.account(c.accountId)!;
    const merchant = store.merchant(account.merchantId);
    const draft = store.saveCase({ ...c, status: "draft", plan: null });
    const plan = templatePlan(draft, account, merchant, []);
    store.saveCase({ ...draft, plan, status: plan.missing.length ? "draft" : "ready" });
  }
}
