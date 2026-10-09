import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, chooseDigit, parseMenu } from "../src/engine/ivr.ts";
import { parseOffer, withinLimits, yearlySavings } from "../src/engine/offers.ts";
import { Vault } from "../src/engine/vault.ts";
import { parseBillText, feeSavings } from "../src/engine/bill.ts";
import { remindersFor } from "../src/engine/outcome.ts";
import { missingInfo, templatePlan } from "../src/engine/planner.ts";
import { templateLetter, splitSubject } from "../src/engine/letters.ts";
import { Store } from "../src/engine/store.ts";
import { BUILTIN_MERCHANTS } from "../src/engine/merchants.ts";
import { account, kase, limits, merchant } from "./fixtures.ts";

test("phone menus parse and the agent heads for retention", () => {
  const text = "For billing and payments, press 1. For technical support, press 2. To cancel or disconnect service, press 4. For all other questions, press 0.";
  const items = parseMenu(text);
  assert.deepEqual(items.map((i) => i.digit), ["1", "2", "4", "0"]);
  assert.equal(classify(text), "menu");
  assert.equal(chooseDigit(items, "lower")?.digit, "4");
  assert.equal(chooseDigit(items, "refund")?.digit, "1");
  assert.equal(chooseDigit(items, "lower", ["4:cancel or disconnect service"])?.digit, "1");
  assert.deepEqual(parseMenu("Press one for English. Press two for Spanish.").map((i) => i.digit), ["1", "2"]);
});

test("classifier tells hold, people, voicemail and closed apart", () => {
  assert.equal(classify("Your call is important to us. Please continue to hold."), "hold");
  assert.equal(classify("Thanks for holding, my name is Priya. Who do I have the pleasure of speaking with?"), "human");
  assert.equal(classify("Our offices are currently closed. Please call back between 8 and 5."), "closed");
  assert.equal(classify("Please leave a message after the tone."), "voicemail");
  assert.equal(classify("In a few words, tell me what you're calling about."), "speech-menu");
  assert.equal(classify("Please enter your account number followed by pound."), "verify-bot");
});

test("offers parse from what reps actually say", () => {
  assert.deepEqual(parseOffer("I can do $59.99 a month for 12 months with no contract."), { monthly: 59.99, months: 12, credit: null, description: "I can do $59.99 a month for 12 months with no contract." });
  assert.equal(parseOffer("I can offer you Gigabit Connect promo at $75 for 12 months.")?.monthly, 75);
  assert.equal(parseOffer("I can give you a one-time courtesy credit of $40.")?.credit, 40);
  assert.equal(parseOffer("I can offer two months free on your current plan.")?.months, 2);
  assert.equal(parseOffer("Let me look at the account."), null);
});

test("limits are enforced in code", () => {
  const l = limits();
  const o = (monthly: number, description = "") => ({ monthly, months: 12, credit: null, description });
  assert.ok(withinLimits("lower", o(60), l, 105).ok);
  assert.ok(!withinLimits("lower", o(80), l, 105).ok);
  assert.ok(!withinLimits("lower", o(110), limits({ maxMonthly: 200 }), 105).ok);
  assert.ok(!withinLimits("lower", { monthly: 55, months: 24, credit: null, description: "24 month contract" }, l, 105).ok);
  assert.ok(withinLimits("lower", { monthly: 55, months: 24, credit: null, description: "24 months, no contract" }, l, 105).ok);
  assert.ok(!withinLimits("cancel", o(12), limits(), 22).ok);
  assert.ok(withinLimits("refund", { monthly: null, months: null, credit: 60, description: "" }, limits({ minRefund: 50 }), 0).ok);
  assert.ok(!withinLimits("refund", { monthly: null, months: null, credit: 30, description: "" }, limits({ minRefund: 50 }), 0).ok);
  assert.equal(yearlySavings(105, 60, 12), 540);
  assert.equal(yearlySavings(22.99, 0, null), 275.88);
});

test("the vault fills placeholders locally and masks secrets read back", () => {
  const v = new Vault(account());
  assert.deepEqual(v.fill("It's {{last4}}."), { text: "It's 4 8 2 1.", missing: [] });
  assert.deepEqual(v.fill("Security answer {{security}}").missing, ["{{security}}"]);
  assert.equal(v.mask("so that's 4 8 2 1 and pin 7316, account 8495 1234 5678 9012"), "so that's {{last4}} and pin {{pin}}, account {{account_number}}");
  assert.equal(v.mask("card 4111 1111 1111 1111"), "card [card number]");
  v.add("answer_1", "Fluffy");
  assert.equal(v.mask("the pet was Fluffy"), "the pet was {{answer_1}}");
});

test("bills parse into an account with fees worth removing", () => {
  const bill = `Xfinity\nAccount Number: 8495 1234 5678 9012\nAccount holder: Jordan Lee\nService address: 742 Evergreen Terrace, Springfield\nPlan: Gigabit Internet\nPromotional rate ends 08/31/2026\nInternet Equipment Rental 15.00\nBroadcast TV Fee 3.00\nTotal amount due $118.00\nPayment due by 10/21/2026`;
  const b = parseBillText(bill, BUILTIN_MERCHANTS);
  assert.equal(b.merchant, "Xfinity (Comcast)");
  assert.equal(b.accountNumber, "8495 1234 5678 9012");
  assert.equal(b.holder, "Jordan Lee");
  assert.equal(b.monthly, 118);
  assert.equal(b.promoEnds, "2026-08-31");
  assert.equal(b.dueDate, "2026-10-21");
  assert.deepEqual(b.fees.map((f) => f.amount), [15, 3]);
  assert.equal(feeSavings(b.fees).length, 1);
});

test("plans list what's missing before the call, once", () => {
  const a = account({ merchantId: "verizon", secrets: {} });
  const missing = missingInfo(a, merchant("verizon"));
  assert.deepEqual(missing.map((m) => m.key), ["pin"]);
  assert.deepEqual(missingInfo(account(), merchant("xfinity")), []);
  const plan = templatePlan(kase(), account(), merchant("xfinity"), [{ id: "l", merchantId: "xfinity", text: "Press 4 for loyalty", at: 0, callId: null }]);
  assert.match(plan.opener, /AI assistant/);
  assert.ok(plan.steps.some((s) => s.includes("Press 4 for loyalty")));
  assert.ok(plan.leverage.some((s) => s.includes("T-Mobile")));
});

test("outcomes turn into reminders before the promo ends and to check credits", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const r = remindersFor(kase(), account(), { result: "won", summary: "", oldMonthly: 105, newMonthly: 60, months: 12, credit: 0, promoEnds: "2027-10-07", confirmation: "PB1", repName: "Dana", promises: [{ text: "New rate of $60 a month shows on the next bill", due: "2026-11-12" }], nextSteps: [], lessons: [] }, now);
  assert.deepEqual(r.map((x) => x.kind).sort(), ["credit", "promo"]);
  assert.equal(new Date(r.find((x) => x.kind === "promo")!.due).toISOString().slice(0, 10), "2027-09-16");
});

test("letters are drafted with the real account details", () => {
  const text = templateLetter({ kind: "cancel", kase: kase({ kind: "cancel" }), account: account(), merchant: merchant("xfinity"), outcome: null, today: "2026-10-07" });
  const { subject, body } = splitSubject(text);
  assert.match(subject, /Cancel my Xfinity/);
  assert.match(body, /8495 1234 5678 9012/);
  assert.match(body, /effective 2026-10-07/);
  assert.doesNotMatch(text, /—/);
});

test("store keeps secrets encrypted and verifies savings against the next bill", () => {
  const cipher = { encrypt: (s: string) => Buffer.from(s).toString("base64"), decrypt: (s: string) => Buffer.from(s, "base64").toString() };
  const store = new Store(":memory:", cipher);
  const a = store.saveAccount({ ...account(), id: undefined });
  const raw = store.db.prepare("SELECT secrets FROM accounts WHERE id = ?").get(a.id) as { secrets: string };
  assert.ok(!raw.secrets.includes("4821"));
  assert.equal(store.account(a.id)!.secrets.last4, "4821");
  const c = store.saveCase({ ...kase(), id: undefined, accountId: a.id });
  store.startCall({ id: "call1", caseId: c.id, line: "sim", startedAt: Date.now() });
  store.addSaving({ caseId: c.id, accountId: a.id, callId: "call1", oldMonthly: 105, newMonthly: 60, months: 12, credit: 0 });
  assert.equal(store.totals().claimed, 540);
  assert.equal(store.checkSavings(a.id, 61)[0].status, "verified");
  assert.equal(store.totals().verified, 540);
  store.addLessons("xfinity", ["Press 4", "press 4", "Ask for loyalty"], "call1");
  assert.equal(store.lessons("xfinity").length, 2);
  assert.equal(store.merchants().length, BUILTIN_MERCHANTS.length + 1);
  store.close();
});
