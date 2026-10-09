import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ClaudeBrain, RefusalError } from "../src/engine/claude.ts";
import { CallSession } from "../src/engine/call.ts";
import { SimLine, ScriptedRep } from "../src/engine/sim.ts";
import { TURN_SCHEMA } from "../src/engine/prompts.ts";
import type { AgentTurn, Outcome } from "../src/engine/types.ts";
import { FAST, account, kase, merchant } from "./fixtures.ts";

function sse(text: string, stopReason = "end_turn") {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ...(text.match(/.{1,12}/gs) ?? [""]).map((t) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } })),
    ev("content_block_stop", { index: 0 }),
    ev("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }),
    ev("message_stop", {}),
  ].join("");
}

type Body = { model: string; system: { text: string; cache_control?: object }[]; messages: { content: { type: string; text?: string }[] }[]; output_config: { effort: string; format?: { schema: object } }; thinking: object; fallbacks: string };

async function fakeApi(reply: (body: Body) => { text: string; stop?: string }) {
  const seen: { headers: Record<string, unknown>; body: Body }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Body;
      seen.push({ headers: req.headers, body });
      const r = reply(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(r.text, r.stop));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, close: () => server.close() };
}

const t = (x: Partial<AgentTurn>): AgentTurn => ({ action: "say", say: "", digits: "", question: "", secret: false, offer: null, decision: "none", note: "", ...x });

test("turn requests use structured output, low effort, caching and redaction", async () => {
  const api = await fakeApi(() => ({ text: JSON.stringify(t({ say: "Sure, it's {{pin}}." })) }));
  try {
    const brain = new ClaudeBrain({ apiKey: "test-key" });
    const out = await brain.json<AgentTurn>({ task: "turn", system: "SYS", context: "CTX card 4242 4242 4242 4242", prompt: "REP: PIN please? my ssn is 123-45-6789" }, TURN_SCHEMA);
    assert.equal(out.say, "Sure, it's {{pin}}.");
    const { headers, body } = api.seen[0];
    assert.equal(headers["x-api-key"], "test-key");
    assert.match(String(headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.fallbacks, "default");
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal(body.output_config.effort, "low");
    assert.deepEqual(body.output_config.format, { type: "json_schema", schema: TURN_SCHEMA });
    assert.ok(body.system[1].cache_control);
    assert.doesNotMatch(body.system[1].text, /4242/);
    assert.doesNotMatch(body.messages[0].content.at(-1)!.text!, /123-45-6789/);
  } finally {
    api.close();
  }
});

test("refusals surface as errors", async () => {
  const api = await fakeApi(() => ({ text: "no", stop: "refusal" }));
  try {
    await assert.rejects(new ClaudeBrain({ apiKey: "k" }).stream({ task: "letter", system: "s", context: "c", prompt: "p" }, () => {}), RefusalError);
  } finally {
    api.close();
  }
});

test("a full simulated call driven by Claude never sends secrets to the model", async () => {
  const offer60 = { monthly: 60, months: 12, credit: null, description: "loyalty rate of $60 a month for 12 months, no contract" };
  const api = await fakeApi((body) => {
    const sys = body.system[0].text;
    const prompt = body.messages[0].content.at(-1)!.text!;
    if (/record what happened/.test(sys)) {
      const o: Outcome = { result: "won", summary: "Lowered to $60.", oldMonthly: 105, newMonthly: 60, months: 12, credit: 0, promoEnds: "2027-10-07", confirmation: "PB123456", repName: "Dana", promises: [{ text: "New rate on next bill", due: "2026-11-12" }], nextSteps: ["Check the next bill"], lessons: ["Loyalty had the $60 rate"] };
      return { text: JSON.stringify(o) };
    }
    const lastRep = prompt.split("\n").filter((l) => l.startsWith("REP:")).at(-1) ?? "";
    let turn: AgentTurn;
    if (/name on the account\?/.test(lastRep)) turn = t({ say: "Hi Dana, I'm an AI assistant calling on behalf of Jordan Lee, who authorized me to discuss the account. This call is recorded. The name is Jordan Lee." });
    else if (/last four/.test(lastRep)) turn = t({ say: "Sure, it's {{last4}}." });
    else if (/How can I help/.test(lastRep)) turn = t({ say: "Jordan pays $105 a month. What promotions does the account qualify for?" });
    else if (/\$10 off/.test(lastRep)) turn = t({ say: "T-Mobile 5G Home Internet is offering about $50 a month. Can you match that?", decision: "counter", offer: { monthly: 95, months: 12, credit: null, description: "$10 off" } });
    else if (/\$75/.test(lastRep)) turn = t({ say: "That's still more than Jordan wants to pay. Jordan is ready to cancel today.", decision: "counter", offer: { monthly: 75, months: 12, credit: null, description: "$75 for 12 months" } });
    else if (/lowest I can go/.test(lastRep)) turn = t({ say: "Then Jordan is ready to cancel today.", decision: "none" });
    else if (/\$60 a month/.test(lastRep) && /apply/.test(lastRep)) turn = t({ say: "That works. Please apply it.", decision: "accept", offer: offer60 });
    else if (/anything else/i.test(lastRep)) turn = t({ say: "No, that's everything. Thank you, Dana." });
    else turn = t({ action: "wait" });
    return { text: JSON.stringify(turn) };
  });
  try {
    const a = account();
    const k = kase();
    const m = merchant("xfinity");
    const line = new SimLine(m, new ScriptedRep(m, a, k, "normal"), 400);
    const s = new CallSession({ kase: k, account: a, merchant: m, lessons: [{ id: "l1", merchantId: "xfinity", text: "Pressing 4 reaches loyalty", at: 0, callId: null }], line, brain: new ClaudeBrain({ apiKey: "k" }), timing: FAST });
    const done = new Promise<Outcome>((r) => s.on("ended", ({ outcome }) => r(outcome)));
    await s.start();
    const outcome = await done;
    assert.equal(outcome.result, "won");
    assert.equal(outcome.newMonthly, 60);
    assert.equal(outcome.oldMonthly, 105);
    assert.ok(outcome.lessons.some((l) => l.startsWith("Phone menu path")));
    const turns = api.seen.filter((x) => x.body.output_config.format && /live phone call/.test(x.body.system[0].text));
    assert.ok(turns.length >= 6, String(turns.length));
    const everything = JSON.stringify(api.seen.map((x) => x.body));
    for (const secret of ["4821", "7316", "8495 1234 5678 9012", "742 Evergreen"]) assert.ok(!everything.includes(secret), secret);
    assert.match(turns[0].body.system[1].text, /\{\{last4\}\}/);
    assert.match(turns[0].body.system[1].text, /Pressing 4 reaches loyalty/);
    assert.ok(s.events.some((e) => e.kind === "agent" && e.text.includes("{{last4}}")));
  } finally {
    api.close();
  }
});

test("a model that repeats itself gets the call ended instead of looping", async () => {
  const api = await fakeApi(() => ({ text: JSON.stringify(t({ say: "What promotions does the account qualify for?" })) }));
  try {
    const a = account();
    const k = kase();
    const m = merchant("xfinity");
    const s = new CallSession({ kase: k, account: a, merchant: m, lessons: [], line: new SimLine(m, new ScriptedRep(m, a, k, "normal"), 400), brain: new ClaudeBrain({ apiKey: "k" }), timing: FAST });
    const done = new Promise<Outcome>((r) => s.on("ended", ({ outcome }) => r(outcome)));
    await s.start();
    await done;
    const turns = api.seen.filter((x) => /live phone call/.test(x.body.system[0].text)).length;
    assert.ok(turns <= 4, String(turns));
    assert.ok(s.events.some((e) => /repeating itself/.test(e.text)));
  } finally {
    api.close();
  }
});
