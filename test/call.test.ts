import { test } from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "../src/engine/call.ts";
import { SimLine, ScriptedRep } from "../src/engine/sim.ts";
import { RehearsalBrain } from "../src/engine/rehearsal.ts";
import type { Account, Case, Merchant, Outcome } from "../src/engine/types.ts";
import { FAST, account, kase, limits, merchant } from "./fixtures.ts";

function run(k: Case, a: Account, m: Merchant, opts: { difficulty?: "easy" | "normal" | "stubborn"; onNeed?: (s: CallSession, need: import("../src/engine/types.ts").Need) => void } = {}) {
  const line = new SimLine(m, new ScriptedRep(m, a, k, opts.difficulty ?? "normal"), 400);
  const s = new CallSession({ kase: k, account: a, merchant: m, lessons: [], line, brain: new RehearsalBrain(), timing: FAST });
  if (opts.onNeed) s.on("need", (n) => opts.onNeed!(s, n));
  return new Promise<{ s: CallSession; outcome: Outcome }>((resolve) => {
    s.on("ended", ({ outcome }) => resolve({ s, outcome }));
    void s.start();
  });
}

const said = (s: CallSession) => s.events.filter((e) => e.kind === "agent").map((e) => e.text);

test("lowers a cable bill through the phone menu, hold and loyalty", async () => {
  const { s, outcome } = await run(kase(), account(), merchant("xfinity"));
  const states = s.events.filter((e) => e.kind === "state").map((e) => e.text);
  assert.ok(states.includes("Phone menu") && states.includes("On hold") && states.includes("Talking to a person"), states.join(","));
  assert.match(said(s)[0], /AI assistant calling on behalf of Jordan Lee/);
  assert.ok(said(s).some((t) => t.includes("{{last4}}")), "speaks the placeholder, not the digits");
  assert.ok(!said(s).some((t) => t.includes("4821")));
  assert.equal(outcome.result, "won");
  assert.equal(outcome.newMonthly, 60);
  assert.equal(outcome.months, 12);
  assert.match(outcome.confirmation ?? "", /^PB\d{6}$/);
  assert.ok(outcome.promoEnds);
  assert.ok(outcome.lessons.some((l) => l.startsWith("Phone menu path")));
});

test("asks the holder for a missing PIN and keeps it out of the transcript", async () => {
  const a = account({ merchantId: "spectrum", secrets: { pin: "" } as Account["secrets"] });
  const real = { ...a, secrets: { pin: "5590" } };
  const m = merchant("spectrum");
  const line = new SimLine(m, new ScriptedRep(m, real, kase(), "normal"), 400);
  const s = new CallSession({ kase: kase(), account: a, merchant: m, lessons: [], line, brain: new RehearsalBrain(), timing: FAST });
  const asked: string[] = [];
  s.on("need", (n) => {
    asked.push(n.question);
    setTimeout(() => s.answer(n.id, "5590"), 5);
  });
  const { outcome } = await new Promise<{ outcome: Outcome }>((resolve) => {
    s.on("ended", resolve);
    void s.start();
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /PIN/);
  assert.ok(!JSON.stringify(s.lines).includes("5590"));
  assert.ok(!JSON.stringify(s.events).includes("5590"));
  assert.ok(["won", "partial"].includes(outcome.result), outcome.summary);
});

test("pauses for approval when the holder wants to approve offers", async () => {
  const k = kase({ limits: limits({ autoAccept: false }) });
  let approvals = 0;
  const { outcome } = await run(k, account(), merchant("xfinity"), {
    onNeed: (s, n) => {
      if (n.kind === "approval") {
        approvals++;
        setTimeout(() => s.approve(n.id, true), 5);
      }
    },
  });
  assert.equal(approvals, 1);
  assert.equal(outcome.result, "won");
});

test("never accepts above the limit without asking", async () => {
  const k = kase({ limits: limits({ targetMonthly: 40, maxMonthly: 45, allowCancel: false }) });
  const questions: string[] = [];
  const { outcome } = await run(k, account(), merchant("xfinity"), { onNeed: (s, n) => { questions.push(n.question); setTimeout(() => s.approve(n.id, false), 5); } });
  assert.notEqual(outcome.newMonthly, 60);
  assert.ok(["lost", "partial"].includes(outcome.result), outcome.result);
});

test("cancels a subscription and declines save offers", async () => {
  const a = account({ merchantId: "siriusxm", monthly: 22.99, plan: "Platinum", secrets: {} });
  const { s, outcome } = await run(kase({ kind: "cancel", goal: "Cancel SiriusXM", limits: limits({ targetMonthly: null, maxMonthly: null }) }), a, merchant("siriusxm"));
  assert.equal(outcome.result, "cancelled", outcome.summary);
  assert.ok(said(s).some((t) => /still like to cancel/.test(t)));
  assert.ok(outcome.confirmation);
});

test("gets a refund after pushing past a partial credit", async () => {
  const k = kase({ kind: "refund", goal: "Refund a duplicate charge", details: "charged twice for September", limits: limits({ refundAmount: 105, minRefund: 50 }) });
  const { outcome } = await run(k, account(), merchant("xfinity"));
  assert.equal(outcome.result, "refunded", outcome.summary);
  assert.equal(outcome.credit, 105);
});

test("stubborn rep needs the holder to authorize", async () => {
  const asked: string[] = [];
  const { outcome } = await run(kase(), account(), merchant("xfinity"), {
    difficulty: "stubborn",
    onNeed: (s, n) => {
      asked.push(n.question);
      setTimeout(() => (n.kind === "approval" ? s.approve(n.id, true) : s.answer(n.id, "I authorize this call")), 5);
    },
  });
  assert.ok(asked.some((q) => /authorize/i.test(q)));
  assert.equal(outcome.result, "won");
});

test("asks for the PIN mid call, then asks before accepting and never loops", async () => {
  const a = account({ merchantId: "verizon", monthly: 90, plan: "Unlimited Plus", secrets: {} });
  const real = { ...a, secrets: { pin: "1357" } };
  const k = kase({ limits: limits({ targetMonthly: 70, maxMonthly: 80, autoAccept: false, allowCancel: false }) });
  const m = merchant("verizon");
  const line = new SimLine(m, new ScriptedRep(m, real, k, "normal"), 400);
  const s = new CallSession({ kase: k, account: a, merchant: m, lessons: [], line, brain: new RehearsalBrain(), timing: FAST });
  const asked: string[] = [];
  s.on("need", (n) => {
    asked.push(n.question);
    setTimeout(() => (n.kind === "approval" ? s.approve(n.id, true) : s.answer(n.id, "1357")), 5);
  });
  const { outcome } = await new Promise<{ outcome: Outcome }>((resolve) => {
    s.on("ended", resolve);
    void s.start();
  });
  assert.equal(asked.length, 2, asked.join(" | "));
  assert.match(asked[1], /^They're offering \$65 a month for 12 months\. Accept it\?$/);
  assert.equal(outcome.newMonthly, 65);
  const agentTurns = s.events.filter((e) => e.kind === "agent").map((e) => e.text);
  assert.equal(new Set(agentTurns).size, agentTurns.length, "no repeated lines");
});

test("takes the best offer inside the limits when nothing else is left", async () => {
  const a = account({ merchantId: "verizon", monthly: 90, plan: "Unlimited Plus", secrets: { pin: "1357" } });
  const k = kase({ limits: limits({ targetMonthly: 50, maxMonthly: 80, allowCancel: false }) });
  const { s, outcome } = await run(k, a, merchant("verizon"));
  assert.equal(outcome.newMonthly, 65, outcome.summary);
  assert.ok(said(s).some((t) => /will take \$65 a month/.test(t)));
});
