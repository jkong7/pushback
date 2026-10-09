import { app, BrowserWindow, Notification, ipcMain, shell, clipboard, powerSaveBlocker } from "electron";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Store } from "../engine/store.ts";
import { ClaudeBrain } from "../engine/claude.ts";
import { RehearsalBrain } from "../engine/rehearsal.ts";
import { CallSession } from "../engine/call.ts";
import { SimLine, ScriptedRep, ClaudeRep, type Difficulty } from "../engine/sim.ts";
import { PhoneServer, TwilioLine } from "../engine/twilio.ts";
import { DeepgramStt, DeepgramTts } from "../engine/deepgram.ts";
import { makePlan, missingInfo } from "../engine/planner.ts";
import { remindersFor } from "../engine/outcome.ts";
import { draftLetter, letterTo, splitSubject } from "../engine/letters.ts";
import { readBill, matchMerchant, feeSavings, type BillFields } from "../engine/bill.ts";
import { Vault } from "../engine/vault.ts";
import type { Account, Brain, Case, LetterKind, Merchant, Need } from "../engine/types.ts";
import { loadEnvFile, keychain, publicSettings, readSettings, isRehearsal, writeSettings, type Settings } from "./config.ts";
import { startTunnel, stopTunnel } from "./tunnel.ts";
import { seedDemo } from "./demo.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
loadEnvFile(app.getAppPath());
if (process.env.PUSHBACK_USER_DATA) app.setPath("userData", process.env.PUSHBACK_USER_DATA);
const SNAP = process.env.PUSHBACK_SNAPSHOT_DIR;
if (SNAP && process.platform === "darwin") app.setActivationPolicy("accessory");

let store: Store;
let win: BrowserWindow | null = null;
const phone = new PhoneServer();
let active: { session: CallSession; caseId: string; needs: Map<string, Need>; blocker: number; line: "sim" | "twilio" } | null = null;

const settings = () => readSettings(store);

function brain(): Brain {
  const s = settings();
  return isRehearsal(s) ? new RehearsalBrain() : new ClaudeBrain({ apiKey: s.anthropicKey, model: s.model });
}

const send = (channel: string, payload?: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function notify(title: string, body: string) {
  if (SNAP || !Notification.isSupported()) return;
  new Notification({ title, body, silent: false }).show();
}

function createWindow(route?: string) {
  if (win && !win.isDestroyed()) {
    if (!SNAP) {
      win.show();
      win.focus();
    }
    if (route) send("nav", route);
    return;
  }
  win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "Pushback",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f6f4ef",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: false, backgroundThrottling: !SNAP, offscreen: Boolean(SNAP) },
  });
  win.loadFile(join(here, "app.html"), route ? { hash: route } : undefined);
  win.once("ready-to-show", () => !SNAP && win?.show());
  win.on("closed", () => (win = null));
  if (process.env.PUSHBACK_DEBUG || SNAP) {
    win.webContents.on("console-message", (e) => console.log(`[renderer] ${e.message}`));
    win.webContents.on("preload-error", (_e, p, err) => console.log(`[preload] ${p} ${err.message}`));
    win.webContents.on("did-finish-load", () => setTimeout(() => void win?.webContents.executeJavaScript("JSON.stringify({ root: document.getElementById('root')?.innerHTML.length, bridge: typeof window.pushback, hash: location.hash })").then((r) => console.log(`[page] ${r}`)), 1500));
    win.webContents.on("dom-ready", () => void win?.webContents.executeJavaScript("window.addEventListener('error', (e) => console.log('STACK ' + (e.error && e.error.stack)))"));
    win.webContents.on("did-fail-load", (_e, code, desc, url) => console.log(`[load-failed] ${code} ${desc} ${url}`));
  }
}

function snapshotState() {
  const s = publicSettings(store);
  const accounts = store.accounts().map(({ secrets, ...a }) => ({ ...a, saved: Object.keys(secrets).filter((k) => secrets[k as keyof typeof secrets]) }));
  return {
    settings: s,
    accounts,
    merchants: store.merchants(),
    cases: store.cases(),
    calls: store.calls(),
    reminders: store.reminders(),
    savings: store.savings(),
    totals: store.totals(),
    lessons: store.lessons(),
    active: active ? { callId: active.session.id, caseId: active.caseId, state: active.session.state, events: active.session.events, needs: [...active.needs.values()], paused: active.session.paused, line: active.line } : null,
  };
}

const changed = () => send("state", snapshotState());

function requireAccount(id: string): Account {
  const a = store.account(id);
  if (!a) throw new Error("Account not found");
  return a;
}

async function startCall(opts: { caseId: string; line: "sim" | "twilio"; difficulty?: Difficulty; repMode?: "scripted" | "claude"; speed?: number }) {
  if (active) throw new Error("A call is already in progress");
  const kase = store.case(opts.caseId);
  if (!kase) throw new Error("Case not found");
  const account = requireAccount(kase.accountId);
  const merchant = store.merchant(account.merchantId);
  const s = settings();
  const b = brain();
  let line;
  if (opts.line === "twilio") {
    const p = publicSettings(store);
    if (!p.liveReady) throw new Error(`Real calls need: ${p.missingForLive.join(", ")}`);
    if (!merchant.phone) throw new Error(`No phone number saved for ${merchant.name}. Add it in Playbooks.`);
    await phone.start(Number(process.env.PUSHBACK_PHONE_PORT ?? 8787));
    line = new TwilioLine({ accountSid: s.twilioSid, authToken: s.twilioToken, from: s.twilioFrom, to: merchant.phone, publicUrl: s.publicUrl, server: phone, stt: () => new DeepgramStt(s.deepgramKey, [merchant.name.split(" (")[0], "retention", "loyalty", "promotion"]), tts: new DeepgramTts(s.deepgramKey, s.voice), record: s.record });
  } else {
    const difficulty = opts.difficulty ?? s.difficulty;
    const rep = (opts.repMode ?? s.repMode) === "claude" && b.name === "claude" ? new ClaudeRep(b, merchant, account, kase, difficulty) : new ScriptedRep(merchant, account, kase, difficulty);
    line = new SimLine(merchant, rep, opts.speed ?? Number(process.env.PUSHBACK_SIM_SPEED ?? 2));
  }
  const session = new CallSession({ kase, account, merchant, lessons: store.lessons(merchant.id), line, brain: b, vault: new Vault(account) });
  const blocker = powerSaveBlocker.start("prevent-app-suspension");
  active = { session, caseId: kase.id, needs: new Map(), blocker, line: line.kind };
  store.startCall({ id: session.id, caseId: kase.id, line: line.kind, startedAt: session.startedAt });
  store.setCaseStatus(kase.id, "calling");
  session.on("event", (e) => {
    if (e.kind !== "partial") store.addEvent(e);
    send("call:event", e);
  });
  session.on("state", (st) => {
    store.setCallState(session.id, st);
    send("call:state", { callId: session.id, state: st });
    if (st !== "ended") changed();
  });
  session.on("human", () => notify("Pushback", `A person at ${merchant.name} picked up.`));
  session.on("need", (n) => {
    active?.needs.set(n.id, n);
    store.setCaseStatus(kase.id, "needs-you");
    send("call:need", n);
    notify("Pushback needs you", n.question);
    changed();
  });
  session.on("resolved", (id) => {
    active?.needs.delete(id);
    if (active && !active.needs.size) store.setCaseStatus(kase.id, "calling");
    send("call:resolved", id);
  });
  session.on("ended", ({ outcome, holdMs, endedAt }) => {
    store.endCall(session.id, outcome, holdMs, endedAt);
    const fresh = store.case(kase.id)!;
    const status: Case["status"] = outcome.result === "won" || outcome.result === "cancelled" || outcome.result === "refunded" ? "won" : outcome.result === "partial" ? "partial" : outcome.result === "no-answer" ? "follow-up" : "lost";
    if (line.kind === "twilio") {
      store.setCaseStatus(kase.id, status);
      if (outcome.newMonthly != null || outcome.credit) store.addSaving({ caseId: kase.id, accountId: account.id, callId: session.id, oldMonthly: account.monthly, newMonthly: outcome.newMonthly, months: outcome.months, credit: outcome.credit });
      store.addLessons(merchant.id, outcome.lessons, session.id);
      for (const r of remindersFor(fresh, account, outcome)) store.addReminder(r);
      if (outcome.newMonthly != null) store.saveAccount({ ...account, monthly: outcome.newMonthly, promoEnds: outcome.promoEnds ?? account.promoEnds, secrets: {} });
    } else store.setCaseStatus(kase.id, fresh.plan?.missing.length ? "draft" : "ready");
    powerSaveBlocker.stop(blocker);
    active = null;
    send("call:ended", { callId: session.id, caseId: kase.id, outcome });
    notify(line.kind === "sim" ? "Dry run finished" : "Call finished", outcome.summary);
    if (SNAP && process.env.PUSHBACK_AUTOSHARE) void shareCard(session.id).then((c) => writeFileSync(join(SNAP, "share-card.png"), Buffer.from(c.dataUrl.split(",")[1], "base64"))).catch((e) => console.log(`[share] ${e.message}`));
    changed();
  });
  changed();
  void session.start();
  return session.id;
}

function registerIpc() {
  const h = (channel: string, fn: (...args: any[]) => unknown) => ipcMain.handle(channel, (_e, ...args) => fn(...args));
  h("state:get", () => snapshotState());
  h("settings:set", (patch: Partial<Settings>) => {
    writeSettings(store, patch);
    changed();
    return publicSettings(store);
  });
  h("tunnel:start", async () => {
    const port = await phone.start(Number(process.env.PUSHBACK_PHONE_PORT ?? 8787));
    const url = await startTunnel(port);
    writeSettings(store, { publicUrl: url });
    changed();
    return url;
  });
  h("account:save", (a: Account & { id?: string }) => {
    const saved = store.saveAccount({ ...a, secrets: a.secrets ?? {} });
    changed();
    return saved.id;
  });
  h("account:delete", (id: string) => {
    store.deleteAccount(id);
    changed();
  });
  h("account:clearSecret", (id: string, key: string) => {
    store.clearSecret(id, key);
    changed();
  });
  h("bill:read", async (input: { text?: string; file?: { data: string; mediaType: "image/png" | "image/jpeg" | "application/pdf" } }) => {
    const merchants = store.merchants();
    const fields = await readBill(brain(), input, merchants);
    return { fields, merchantId: matchMerchant(fields.merchant, merchants)?.id ?? "other", tips: feeSavings(fields.fees) };
  });
  h("bill:apply", (accountId: string, fields: BillFields) => {
    const a = requireAccount(accountId);
    const result: string[] = [];
    if (fields.monthly != null) {
      const checks = store.checkSavings(accountId, fields.monthly);
      for (const c of checks) result.push(c.status === "verified" ? `Verified: the bill shows $${fields.monthly}, so the $${c.yearly.toFixed(0)}/yr saving is real.` : `Missed: the bill shows $${fields.monthly}, not the promised $${c.newMonthly}. A follow-up reminder was added.`);
      for (const c of checks.filter((x) => x.status === "missed")) store.addReminder({ id: crypto.randomUUID(), caseId: c.caseId, accountId, due: Date.now(), kind: "follow-up", text: `${a.label}: the promised $${c.newMonthly} rate didn't show up. Call back or send a follow-up letter.`, done: false });
      if (fields.monthly > a.monthly + 1 && !checks.length) {
        result.push(`Price went up from $${a.monthly} to $${fields.monthly}.`);
        store.addReminder({ id: crypto.randomUUID(), caseId: null, accountId, due: Date.now(), kind: "price", text: `${a.label} went up from $${a.monthly} to $${fields.monthly}.`, done: false });
      }
    }
    store.saveAccount({ ...a, monthly: fields.monthly ?? a.monthly, promoEnds: fields.promoEnds ?? a.promoEnds, plan: fields.plan ?? a.plan, accountNumber: a.accountNumber || fields.accountNumber || "", address: a.address || fields.address || "", holder: a.holder || fields.holder || "", secrets: {} });
    changed();
    return result;
  });
  h("case:save", (c: Case & { id?: string }) => {
    const saved = store.saveCase({ ...c, status: c.status ?? "draft", plan: c.plan ?? null });
    changed();
    return saved.id;
  });
  h("case:delete", (id: string) => {
    store.deleteCase(id);
    changed();
  });
  h("case:plan", async (id: string) => {
    const c = store.case(id)!;
    const a = requireAccount(c.accountId);
    const m = store.merchant(a.merchantId);
    const plan = await makePlan(brain(), c, a, m, store.lessons(m.id), new Vault(a).available());
    store.saveCase({ ...c, plan, status: plan.missing.length ? "draft" : "ready" });
    changed();
    return plan;
  });
  h("case:missing", (id: string) => {
    const c = store.case(id)!;
    const a = requireAccount(c.accountId);
    return missingInfo(a, store.merchant(a.merchantId));
  });
  h("case:detail", (id: string) => {
    const c = store.case(id);
    if (!c) return null;
    return { calls: store.calls(id), letters: store.letters(id), reminders: store.reminders(true).filter((r) => r.caseId === id) };
  });
  h("call:start", (opts: Parameters<typeof startCall>[0]) => startCall(opts));
  h("call:get", (id: string) => store.call(id));
  h("call:answer", (id: string, text: string) => active?.session.answer(id, text));
  h("call:approve", (id: string, yes: boolean) => active?.session.approve(id, yes));
  h("call:say", (text: string) => active?.session.inject(text));
  h("call:pause", (p: boolean) => active?.session.setPaused(p));
  h("call:hangup", () => active?.session.hangup());
  h("call:handoff", () => {
    const p = settings().myPhone;
    if (!p) throw new Error("Add your phone number in Settings first");
    return active?.session.handoff(p);
  });
  h("letter:draft", async (caseId: string, kind: LetterKind) => {
    const kase = store.case(caseId)!;
    const account = requireAccount(kase.accountId);
    const merchant = store.merchant(account.merchantId);
    const last = store.calls(caseId).find((c) => c.outcome)?.outcome ?? null;
    const text = await draftLetter(brain(), { kind, kase, account, merchant, outcome: last }, (t) => send("letter:delta", { caseId, kind, text: t }));
    const { subject, body } = splitSubject(text);
    const letter = store.saveLetter({ caseId, kind, subject, to: letterTo(kind, merchant), body });
    changed();
    return letter;
  });
  h("merchant:save", (m: Merchant) => {
    const saved = store.saveMerchant(m);
    changed();
    return saved.id;
  });
  h("lesson:delete", (id: string) => {
    store.deleteLesson(id);
    changed();
  });
  h("reminder:done", (id: string) => {
    store.setReminderDone(id);
    changed();
  });
  h("clipboard:write", (text: string) => clipboard.writeText(text));
  h("mail:open", (to: string, subject: string, body: string) => shell.openExternal(`mailto:${/@/.test(to) ? encodeURIComponent(to) : ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`));
  h("share:card", (callId: string) => shareCard(callId));
  h("file:reveal", (path: string) => shell.showItemInFolder(path));
  h("demo:seed", () => {
    seedDemo(store);
    changed();
  });
}

async function shareCard(callId: string) {
  const call = store.call(callId);
  if (!call?.outcome) throw new Error("No outcome to share yet");
  if (!["won", "partial", "cancelled", "refunded"].includes(call.outcome.result)) throw new Error("Share cards are for wins");
  const kase = store.case(call.caseId)!;
  const account = requireAccount(kase.accountId);
  const merchant = store.merchant(account.merchantId);
  const o = call.outcome;
  const minutes = Math.max(1, Math.round(((call.endedAt ?? Date.now()) - call.startedAt) / 60000));
  const data = { merchant: merchant.name.split(" (")[0], result: o.result, summary: o.summary, old: o.oldMonthly, now: o.newMonthly, credit: o.credit, months: o.months, minutes, hold: Math.round(call.holdMs / 60000), quote: call.events.filter((e) => e.kind === "agent").map((e) => e.text).find((t) => /offering|ready to cancel|full \$/.test(t)) ?? "" };
  const card = new BrowserWindow({ show: false, width: 1080, height: 1080, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await card.loadFile(join(here, "card.html"), { hash: encodeURIComponent(JSON.stringify(data)) });
  await new Promise((r) => setTimeout(r, 400));
  const img = await card.webContents.capturePage();
  card.destroy();
  const dir = join(app.getPath("userData"), "cards");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `pushback-${merchant.id}-${new Date().toISOString().slice(0, 10)}-${callId.slice(0, 6)}.png`);
  writeFileSync(path, img.toPNG());
  return { path, dataUrl: img.toDataURL() };
}

function checkReminders() {
  for (const r of store.dueUnnotified()) notify("Pushback reminder", r.text);
  changed();
}

app.whenReady().then(async () => {
  if (SNAP && process.platform === "darwin") app.dock?.hide();
  mkdirSync(app.getPath("userData"), { recursive: true });
  store = new Store(join(app.getPath("userData"), "pushback.db"), keychain);
  store.closeStaleCalls();
  if (process.env.PUSHBACK_SEED === "1" && !store.accounts().length) seedDemo(store);
  registerIpc();
  createWindow(process.env.PUSHBACK_ROUTE);
  setInterval(checkReminders, 30 * 60000);
  setTimeout(checkReminders, 5000);
  if (process.env.PUSHBACK_AUTOCALL) {
    const idx = Number(process.env.PUSHBACK_AUTOCALL) || 0;
    setTimeout(async () => {
      const acct = store.accounts()[idx];
      const c = store.cases().find((x) => x.accountId === acct?.id);
      if (!c) return;
      if (!c.plan) {
        const a = requireAccount(c.accountId);
        const m = store.merchant(a.merchantId);
        store.saveCase({ ...c, plan: await makePlan(brain(), c, a, m, store.lessons(m.id), new Vault(a).available()), status: "ready" });
      }
      const id = await startCall({ caseId: c.id, line: "sim", difficulty: (process.env.PUSHBACK_DIFFICULTY as Difficulty) ?? undefined, speed: Number(process.env.PUSHBACK_SIM_SPEED ?? 1.6) });
      send("nav", `call/${id}`);
      if (process.env.PUSHBACK_AUTOANSWER) {
        const timer = setInterval(() => {
          if (!active) return clearInterval(timer);
          for (const n of active.needs.values()) {
            if (n.kind === "approval") active.session.approve(n.id, true);
            else active.session.answer(n.id, /authori/i.test(n.question) ? "I authorize this call" : process.env.PUSHBACK_AUTOANSWER!);
          }
        }, 1500);
      }
    }, 1500);
  }
  if (SNAP) startSnapshots(SNAP);
});

function startSnapshots(dir: string) {
  mkdirSync(dir, { recursive: true });
  let n = 0;
  const routes = (process.env.PUSHBACK_SNAPSHOT_ROUTES ?? "").split(",").filter(Boolean);
  setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    n++;
    let label = "app";
    if (routes.length) {
      const accounts = store.accounts();
      const cases = accounts.map((a) => store.cases().find((x) => x.accountId === a.id)).filter((x) => x !== undefined);
      const route = routes[(n - 1) % routes.length].replace(/\{case(\d)\}/, (_m, i) => cases[Number(i)]?.id ?? "").replace(/\{account(\d)\}/, (_m, i) => accounts[Number(i)]?.id ?? "").replace(/\{call\}/, () => store.calls()[0]?.id ?? "");
      label = routes[(n - 1) % routes.length].replace(/[^a-z0-9]+/gi, "-");
      send("nav", route);
      await new Promise((r) => setTimeout(r, 900));
    }
    const img = await win.webContents.capturePage();
    writeFileSync(join(dir, `${String(n).padStart(3, "0")}-${label}.png`), img.toPNG());
  }, Number(process.env.PUSHBACK_SNAPSHOT_MS ?? 3000));
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => createWindow());

app.on("will-quit", () => {
  stopTunnel();
  phone.stop();
  store?.close();
});
