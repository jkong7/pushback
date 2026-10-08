import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Account, CallEvent, CallRow, Case, Lesson, Letter, Merchant, Outcome, Reminder } from "./types.ts";
import { BUILTIN_MERCHANTS, GENERIC_MERCHANT } from "./merchants.ts";
import { yearlySavings } from "./offers.ts";

export interface Cipher {
  encrypt(s: string): string;
  decrypt(s: string): string;
}

export const PLAIN: Cipher = { encrypt: (s) => s, decrypt: (s) => s };

export interface Saving {
  id: string;
  caseId: string;
  accountId: string;
  callId: string;
  oldMonthly: number | null;
  newMonthly: number | null;
  months: number | null;
  credit: number;
  yearly: number;
  status: "claimed" | "verified" | "missed";
  at: number;
  checkedAt: number | null;
}

export interface CallDetail extends CallRow {
  events: CallEvent[];
}

type Row = Record<string, unknown>;
const j = <T>(v: unknown, d: T): T => {
  if (typeof v !== "string" || !v) return d;
  try {
    return JSON.parse(v) as T;
  } catch {
    return d;
  }
};

export class Store {
  db: DatabaseSync;

  private cipher: Cipher;

  constructor(path: string, cipher: Cipher = PLAIN) {
    this.cipher = cipher;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS merchants (id TEXT PRIMARY KEY, data TEXT, builtin INTEGER, sort INTEGER);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, merchant_id TEXT, label TEXT, holder TEXT, account_number TEXT, address TEXT, phone TEXT, plan TEXT, monthly REAL, promo_ends TEXT, notes TEXT, secrets TEXT, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, account_id TEXT, kind TEXT, goal TEXT, details TEXT, limits TEXT, status TEXT, plan TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, case_id TEXT, line TEXT, started_at INTEGER, ended_at INTEGER, state TEXT, outcome TEXT, hold_ms INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, call_id TEXT, at INTEGER, kind TEXT, text TEXT, data TEXT);
      CREATE INDEX IF NOT EXISTS events_call ON events (call_id, at);
      CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, case_id TEXT, account_id TEXT, due INTEGER, kind TEXT, text TEXT, done INTEGER DEFAULT 0, notified INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY, merchant_id TEXT, text TEXT, at INTEGER, call_id TEXT);
      CREATE TABLE IF NOT EXISTS letters (id TEXT PRIMARY KEY, case_id TEXT, kind TEXT, subject TEXT, recipient TEXT, body TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS savings (id TEXT PRIMARY KEY, case_id TEXT, account_id TEXT, call_id TEXT, old_monthly REAL, new_monthly REAL, months INTEGER, credit REAL, yearly REAL, status TEXT, at INTEGER, checked_at INTEGER);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    `);
    const ins = this.db.prepare("INSERT OR IGNORE INTO merchants (id, data, builtin, sort) VALUES (?, ?, 1, ?)");
    [...BUILTIN_MERCHANTS, GENERIC_MERCHANT].forEach((m, i) => ins.run(m.id, JSON.stringify({ ...m, builtin: true }), i));
  }

  close() {
    this.db.close();
  }

  getSetting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return (r?.value as string) ?? null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  merchants(): Merchant[] {
    return (this.db.prepare("SELECT data FROM merchants ORDER BY sort, id").all() as Row[]).map((r) => j<Merchant>(r.data, GENERIC_MERCHANT));
  }

  merchant(id: string): Merchant {
    const r = this.db.prepare("SELECT data FROM merchants WHERE id = ?").get(id) as Row | undefined;
    return r ? j<Merchant>(r.data, GENERIC_MERCHANT) : GENERIC_MERCHANT;
  }

  saveMerchant(m: Merchant): Merchant {
    const id = m.id || randomUUID();
    const existing = this.db.prepare("SELECT builtin, sort FROM merchants WHERE id = ?").get(id) as Row | undefined;
    const merged = { ...m, id };
    this.db.prepare("INSERT INTO merchants (id, data, builtin, sort) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(id, JSON.stringify(merged), existing ? Number(existing.builtin) : 0, existing ? Number(existing.sort) : 100);
    return merged;
  }

  accounts(): Account[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY created_at, rowid").all() as Row[]).map((r) => this.toAccount(r));
  }

  account(id: string): Account | null {
    const r = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toAccount(r) : null;
  }

  private toAccount(r: Row): Account {
    let secrets = {};
    try {
      secrets = JSON.parse(this.cipher.decrypt(String(r.secrets ?? "")) || "{}");
    } catch {
      secrets = {};
    }
    return {
      id: String(r.id),
      merchantId: String(r.merchant_id),
      label: String(r.label ?? ""),
      holder: String(r.holder ?? ""),
      accountNumber: String(r.account_number ?? ""),
      address: String(r.address ?? ""),
      phoneOnFile: String(r.phone ?? ""),
      plan: String(r.plan ?? ""),
      monthly: Number(r.monthly ?? 0),
      promoEnds: (r.promo_ends as string) || null,
      notes: String(r.notes ?? ""),
      secrets,
      createdAt: Number(r.created_at),
    };
  }

  saveAccount(a: Omit<Account, "id" | "createdAt"> & { id?: string; createdAt?: number }): Account {
    const id = a.id || randomUUID();
    const prev = this.account(id);
    const secrets = { ...(prev?.secrets ?? {}), ...a.secrets };
    for (const k of Object.keys(secrets) as (keyof typeof secrets)[]) if (!secrets[k]) delete secrets[k];
    const createdAt = prev?.createdAt ?? a.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO accounts (id, merchant_id, label, holder, account_number, address, phone, plan, monthly, promo_ends, notes, secrets, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET merchant_id = excluded.merchant_id, label = excluded.label, holder = excluded.holder, account_number = excluded.account_number, address = excluded.address, phone = excluded.phone, plan = excluded.plan, monthly = excluded.monthly, promo_ends = excluded.promo_ends, notes = excluded.notes, secrets = excluded.secrets`,
      )
      .run(id, a.merchantId, a.label, a.holder, a.accountNumber, a.address, a.phoneOnFile, a.plan, a.monthly, a.promoEnds, a.notes, this.cipher.encrypt(JSON.stringify(secrets)), createdAt);
    return this.account(id)!;
  }

  clearSecret(accountId: string, key: string) {
    const a = this.account(accountId);
    if (!a) return;
    const secrets = { ...a.secrets } as Record<string, string>;
    delete secrets[key];
    this.db.prepare("UPDATE accounts SET secrets = ? WHERE id = ?").run(this.cipher.encrypt(JSON.stringify(secrets)), accountId);
  }

  deleteAccount(id: string) {
    for (const c of this.cases().filter((c) => c.accountId === id)) this.deleteCase(c.id);
    this.db.prepare("DELETE FROM reminders WHERE account_id = ?").run(id);
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }

  cases(): Case[] {
    return (this.db.prepare("SELECT * FROM cases ORDER BY updated_at DESC").all() as Row[]).map(this.toCase);
  }

  case(id: string): Case | null {
    const r = this.db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toCase(r) : null;
  }

  private toCase = (r: Row): Case => ({
    id: String(r.id),
    accountId: String(r.account_id),
    kind: r.kind as Case["kind"],
    goal: String(r.goal ?? ""),
    details: String(r.details ?? ""),
    limits: j(r.limits, {} as Case["limits"]),
    status: r.status as Case["status"],
    plan: j(r.plan, null),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });

  saveCase(c: Omit<Case, "id" | "createdAt" | "updatedAt"> & { id?: string }): Case {
    const id = c.id || randomUUID();
    const now = Date.now();
    const prev = this.case(id);
    this.db
      .prepare(
        `INSERT INTO cases (id, account_id, kind, goal, details, limits, status, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, kind = excluded.kind, goal = excluded.goal, details = excluded.details, limits = excluded.limits, status = excluded.status, plan = excluded.plan, updated_at = excluded.updated_at`,
      )
      .run(id, c.accountId, c.kind, c.goal, c.details, JSON.stringify(c.limits), c.status, c.plan ? JSON.stringify(c.plan) : null, prev?.createdAt ?? now, now);
    return this.case(id)!;
  }

  setCaseStatus(id: string, status: Case["status"]) {
    this.db.prepare("UPDATE cases SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
  }

  deleteCase(id: string) {
    for (const c of this.calls(id)) this.db.prepare("DELETE FROM events WHERE call_id = ?").run(c.id);
    for (const t of ["calls", "letters", "savings", "reminders"]) this.db.prepare(`DELETE FROM ${t} WHERE case_id = ?`).run(id);
    this.db.prepare("DELETE FROM cases WHERE id = ?").run(id);
  }

  startCall(c: { id: string; caseId: string; line: CallRow["line"]; startedAt: number }) {
    this.db.prepare("INSERT INTO calls (id, case_id, line, started_at, state) VALUES (?, ?, ?, ?, 'dialing')").run(c.id, c.caseId, c.line, c.startedAt);
  }

  setCallState(id: string, state: CallRow["state"]) {
    this.db.prepare("UPDATE calls SET state = ? WHERE id = ?").run(state, id);
  }

  endCall(id: string, outcome: Outcome, holdMs: number, endedAt: number) {
    this.db.prepare("UPDATE calls SET ended_at = ?, state = 'ended', outcome = ?, hold_ms = ? WHERE id = ?").run(endedAt, JSON.stringify(outcome), Math.round(holdMs), id);
  }

  addEvent(e: CallEvent) {
    this.db.prepare("INSERT OR IGNORE INTO events (id, call_id, at, kind, text, data) VALUES (?, ?, ?, ?, ?, ?)").run(e.id, e.callId, e.at, e.kind, e.text, e.data === undefined ? null : JSON.stringify(e.data));
  }

  private toCall = (r: Row): CallRow => ({
    id: String(r.id),
    caseId: String(r.case_id),
    line: r.line as CallRow["line"],
    startedAt: Number(r.started_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    state: r.state as CallRow["state"],
    outcome: j(r.outcome, null),
    holdMs: Number(r.hold_ms ?? 0),
  });

  calls(caseId?: string): CallRow[] {
    const rows = caseId ? this.db.prepare("SELECT * FROM calls WHERE case_id = ? ORDER BY started_at DESC").all(caseId) : this.db.prepare("SELECT * FROM calls ORDER BY started_at DESC").all();
    return (rows as Row[]).map(this.toCall);
  }

  call(id: string): CallDetail | null {
    const r = this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    const events = (this.db.prepare("SELECT * FROM events WHERE call_id = ? ORDER BY at, rowid").all(id) as Row[]).map((e) => ({ id: String(e.id), callId: id, at: Number(e.at), kind: e.kind as CallEvent["kind"], text: String(e.text), data: j(e.data, undefined) }));
    return { ...this.toCall(r), events };
  }

  closeStaleCalls() {
    this.db.prepare("UPDATE calls SET state = 'ended', ended_at = COALESCE(ended_at, started_at) WHERE state != 'ended'").run();
    this.db.prepare("UPDATE cases SET status = 'ready' WHERE status IN ('calling', 'needs-you')").run();
  }

  reminders(includeDone = false): Reminder[] {
    const rows = this.db.prepare(`SELECT * FROM reminders ${includeDone ? "" : "WHERE done = 0"} ORDER BY due`).all() as Row[];
    return rows.map((r) => ({ id: String(r.id), caseId: (r.case_id as string) || null, accountId: String(r.account_id), due: Number(r.due), kind: r.kind as Reminder["kind"], text: String(r.text), done: Boolean(r.done) }));
  }

  addReminder(r: Reminder) {
    this.db.prepare("INSERT INTO reminders (id, case_id, account_id, due, kind, text, done) VALUES (?, ?, ?, ?, ?, ?, ?)").run(r.id, r.caseId, r.accountId, r.due, r.kind, r.text, r.done ? 1 : 0);
  }

  setReminderDone(id: string, done = true) {
    this.db.prepare("UPDATE reminders SET done = ? WHERE id = ?").run(done ? 1 : 0, id);
  }

  dueUnnotified(now = Date.now()): Reminder[] {
    const rows = this.db.prepare("SELECT * FROM reminders WHERE done = 0 AND notified = 0 AND due <= ?").all(now) as Row[];
    this.db.prepare("UPDATE reminders SET notified = 1 WHERE done = 0 AND notified = 0 AND due <= ?").run(now);
    return rows.map((r) => ({ id: String(r.id), caseId: (r.case_id as string) || null, accountId: String(r.account_id), due: Number(r.due), kind: r.kind as Reminder["kind"], text: String(r.text), done: false }));
  }

  lessons(merchantId?: string): Lesson[] {
    const rows = merchantId ? this.db.prepare("SELECT * FROM lessons WHERE merchant_id = ? ORDER BY at DESC").all(merchantId) : this.db.prepare("SELECT * FROM lessons ORDER BY at DESC").all();
    return (rows as Row[]).map((r) => ({ id: String(r.id), merchantId: String(r.merchant_id), text: String(r.text), at: Number(r.at), callId: (r.call_id as string) || null }));
  }

  addLessons(merchantId: string, texts: string[], callId: string | null) {
    const existing = new Set(this.lessons(merchantId).map((l) => l.text.toLowerCase()));
    for (const t of texts) {
      if (!t.trim() || existing.has(t.toLowerCase())) continue;
      existing.add(t.toLowerCase());
      this.db.prepare("INSERT INTO lessons (id, merchant_id, text, at, call_id) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), merchantId, t.trim(), Date.now(), callId);
    }
  }

  deleteLesson(id: string) {
    this.db.prepare("DELETE FROM lessons WHERE id = ?").run(id);
  }

  letters(caseId: string): Letter[] {
    return (this.db.prepare("SELECT * FROM letters WHERE case_id = ? ORDER BY at DESC").all(caseId) as Row[]).map((r) => ({ id: String(r.id), caseId, kind: r.kind as Letter["kind"], subject: String(r.subject), to: String(r.recipient), body: String(r.body), at: Number(r.at) }));
  }

  saveLetter(l: Omit<Letter, "id" | "at">): Letter {
    const id = randomUUID();
    const at = Date.now();
    this.db.prepare("INSERT INTO letters (id, case_id, kind, subject, recipient, body, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, l.caseId, l.kind, l.subject, l.to, l.body, at);
    return { ...l, id, at };
  }

  addSaving(s: Omit<Saving, "id" | "yearly" | "status" | "at" | "checkedAt">): Saving {
    const row: Saving = { ...s, id: randomUUID(), yearly: yearlySavings(s.oldMonthly, s.newMonthly, s.months, s.credit), status: "claimed", at: Date.now(), checkedAt: null };
    this.db.prepare("INSERT INTO savings (id, case_id, account_id, call_id, old_monthly, new_monthly, months, credit, yearly, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.caseId, row.accountId, row.callId, row.oldMonthly, row.newMonthly, row.months, row.credit, row.yearly, row.status, row.at);
    return row;
  }

  savings(): Saving[] {
    return (this.db.prepare("SELECT * FROM savings ORDER BY at DESC").all() as Row[]).map((r) => ({
      id: String(r.id),
      caseId: String(r.case_id),
      accountId: String(r.account_id),
      callId: String(r.call_id),
      oldMonthly: r.old_monthly as number | null,
      newMonthly: r.new_monthly as number | null,
      months: r.months as number | null,
      credit: Number(r.credit ?? 0),
      yearly: Number(r.yearly ?? 0),
      status: r.status as Saving["status"],
      at: Number(r.at),
      checkedAt: r.checked_at == null ? null : Number(r.checked_at),
    }));
  }

  checkSavings(accountId: string, billMonthly: number): Saving[] {
    const changed: Saving[] = [];
    for (const s of this.savings().filter((x) => x.accountId === accountId && x.status === "claimed" && x.newMonthly != null)) {
      const status = billMonthly <= s.newMonthly! + 1 ? "verified" : "missed";
      this.db.prepare("UPDATE savings SET status = ?, checked_at = ? WHERE id = ?").run(status, Date.now(), s.id);
      changed.push({ ...s, status, checkedAt: Date.now() });
    }
    return changed;
  }

  totals() {
    const s = this.savings();
    const sum = (f: (x: Saving) => boolean) => s.filter(f).reduce((n, x) => n + x.yearly, 0);
    const calls = this.calls();
    return {
      verified: sum((x) => x.status === "verified"),
      claimed: sum((x) => x.status === "claimed"),
      missed: sum((x) => x.status === "missed"),
      calls: calls.length,
      holdMinutes: Math.round(calls.reduce((n, c) => n + c.holdMs, 0) / 60000),
      wins: s.length,
    };
  }
}
