import { useEffect, useState } from "react";
import { api, money, ago, until, KIND_LABEL, STATUS_LABEL, type AppState } from "./api.ts";
import type { CallRow, Case, CaseKind, Letter, LetterKind, Limits, Reminder, Secret } from "../engine/types.ts";
import { SECRET_LABELS } from "../engine/types.ts";

export function Cases({ state, go }: { state: AppState; go: (r: string) => void }) {
  return (
    <div className="page">
      <h1>Cases</h1>
      {!state.cases.length && <p className="muted">No cases yet. Pick an account on Home and choose what you want done.</p>}
      <div className="list">
        {state.cases.map((c) => {
          const a = state.accounts.find((x) => x.id === c.accountId);
          return (
            <div key={c.id} className="item clickable" onClick={() => go(`case/${c.id}`)}>
              <span className={`status ${c.status}`}>{STATUS_LABEL[c.status]}</span>
              <span className="grow">
                <strong>{a?.label}</strong> <span className="muted">{c.goal}</span>
              </span>
              <span className="muted small">{KIND_LABEL[c.kind]}</span>
              <span className="muted small">{ago(c.updatedAt)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const defaults = (kind: CaseKind, monthly: number): Limits => ({
  targetMonthly: kind === "lower" ? Math.round(monthly * 0.6) : null,
  maxMonthly: kind === "lower" ? Math.round(monthly * 0.8) : null,
  maxContractMonths: kind === "lower" ? 12 : 0,
  allowCancel: false,
  allowDowngrade: false,
  refundAmount: null,
  minRefund: null,
  autoAccept: true,
});

const GOALS: Record<CaseKind, (label: string) => string> = {
  lower: (l) => `Lower the ${l.toLowerCase()} bill`,
  cancel: (l) => `Cancel ${l.toLowerCase()}`,
  refund: () => "Get a charge refunded",
  dispute: () => "Dispute a charge",
};

export function CaseEditor({ state, accountId, kind, caseId, go }: { state: AppState; accountId?: string; kind?: string; caseId?: string; go: (r: string) => void }) {
  const existing = state.cases.find((c) => c.id === caseId);
  const acct = state.accounts.find((a) => a.id === (existing?.accountId ?? accountId)) ?? state.accounts[0];
  const k0 = (existing?.kind ?? (kind as CaseKind) ?? "lower") as CaseKind;
  const [k, setK] = useState<CaseKind>(k0);
  const [goal, setGoal] = useState(existing?.goal ?? GOALS[k0](acct?.label ?? "account"));
  const [details, setDetails] = useState(existing?.details ?? "");
  const [limits, setLimits] = useState<Limits>(existing?.limits ?? defaults(k0, acct?.monthly ?? 0));
  if (!acct) return <div className="page"><p>Add an account first.</p></div>;
  const L = <K extends keyof Limits>(key: K, v: Limits[K]) => setLimits((l) => ({ ...l, [key]: v }));
  const num = (v: string) => (v === "" ? null : Number(v));
  const changeKind = (nk: CaseKind) => {
    setK(nk);
    if (!existing) {
      setGoal(GOALS[nk](acct.label));
      setLimits(defaults(nk, acct.monthly));
    }
  };
  const save = async () => {
    const id = await api.invoke<string>("case:save", { ...(existing ?? {}), id: existing?.id, accountId: acct.id, kind: k, goal, details, limits, status: existing?.status ?? "draft", plan: existing?.plan ?? null });
    await api.invoke("case:plan", id);
    go(`case/${id}`);
  };
  return (
    <div className="page narrow">
      <h1>{existing ? "Edit case" : `New case: ${acct.label}`}</h1>
      <section className="card form">
        <div className="seg">
          {(["lower", "cancel", "refund", "dispute"] as CaseKind[]).map((x) => (
            <button key={x} className={k === x ? "on" : ""} onClick={() => changeKind(x)}>{KIND_LABEL[x]}</button>
          ))}
        </div>
        <label>
          Goal
          <input value={goal} onChange={(e) => setGoal(e.target.value)} />
        </label>
        <label>
          Details the agent should know
          <textarea rows={3} value={details} placeholder={k === "refund" ? "Charged twice on Sep 3 for $105" : "Customer since 2021, outages in August, a neighbor pays $55"} onChange={(e) => setDetails(e.target.value)} />
        </label>
      </section>
      <section className="card form">
        <h3>Your limits</h3>
        <p className="muted small">Enforced in code. The agent can't accept anything outside these without pausing to ask you.</p>
        {k === "lower" && (
          <>
            <div className="row gap">
              <label className="grow">
                Target per month
                <input type="number" value={limits.targetMonthly ?? ""} onChange={(e) => L("targetMonthly", num(e.target.value))} />
              </label>
              <label className="grow">
                Most you'd accept
                <input type="number" value={limits.maxMonthly ?? ""} onChange={(e) => L("maxMonthly", num(e.target.value))} />
              </label>
              <label className="grow">
                Longest contract (months)
                <input type="number" value={limits.maxContractMonths} onChange={(e) => L("maxContractMonths", Number(e.target.value) || 0)} />
              </label>
            </div>
            <p className="muted small">Currently {money(acct.monthly, 2)} a month.</p>
            <label className="check">
              <input type="checkbox" checked={limits.allowCancel} onChange={(e) => L("allowCancel", e.target.checked)} /> I'm really willing to cancel if they won't move (lets the agent say so and schedule a disconnect)
            </label>
            <label className="check">
              <input type="checkbox" checked={limits.allowDowngrade} onChange={(e) => L("allowDowngrade", e.target.checked)} /> A slower or smaller plan is fine
            </label>
          </>
        )}
        {k === "cancel" && (
          <>
            <label className="check">
              <input type="checkbox" checked={limits.allowDowngrade} onChange={(e) => L("allowDowngrade", e.target.checked)} /> I'd keep it for a low enough price
            </label>
            {limits.allowDowngrade && (
              <label>
                Keep it only at or below (per month)
                <input type="number" value={limits.maxMonthly ?? ""} onChange={(e) => L("maxMonthly", num(e.target.value))} />
              </label>
            )}
          </>
        )}
        {(k === "refund" || k === "dispute") && (
          <div className="row gap">
            <label className="grow">
              Amount to get back
              <input type="number" value={limits.refundAmount ?? ""} onChange={(e) => L("refundAmount", num(e.target.value))} />
            </label>
            <label className="grow">
              Lowest acceptable credit
              <input type="number" value={limits.minRefund ?? ""} onChange={(e) => L("minRefund", num(e.target.value))} />
            </label>
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={limits.autoAccept} onChange={(e) => L("autoAccept", e.target.checked)} /> Accept offers inside my limits without asking me
        </label>
      </section>
      <div className="row gap">
        <button className="primary" onClick={save}>Save and plan the call</button>
        <button onClick={() => history.back()}>Back</button>
      </div>
    </div>
  );
}

const LETTERS: { kind: LetterKind; label: string; when: CaseKind[] }[] = [
  { kind: "cancel", label: "Cancellation letter", when: ["cancel"] },
  { kind: "refund", label: "Refund request", when: ["refund", "dispute"] },
  { kind: "follow-up", label: "Follow-up on promises", when: ["lower", "cancel", "refund", "dispute"] },
  { kind: "complaint", label: "Regulator complaint", when: ["lower", "cancel", "refund", "dispute"] },
  { kind: "chargeback", label: "Card dispute", when: ["refund", "dispute", "cancel"] },
];

function MissingInfo({ c, accountId, saved }: { c: Case; accountId: string; saved: Secret[] }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const missing = (c.plan?.missing ?? []).filter((m) => !saved.includes(m.key as Secret));
  if (!missing.length) return null;
  const save = async () => {
    const secrets: Record<string, string> = {};
    const plain: Record<string, string> = {};
    for (const [k, v] of Object.entries(vals)) {
      if (!v.trim()) continue;
      if (k in SECRET_LABELS) secrets[k] = v.trim();
      else plain[k === "account_number" ? "accountNumber" : k] = v.trim();
    }
    const state = await api.invoke<AppState>("state:get");
    const a = state.accounts.find((x) => x.id === accountId)!;
    await api.invoke("account:save", { ...a, ...plain, secrets });
    await api.invoke("case:plan", c.id);
  };
  return (
    <section className="card warn form">
      <h3>Before calling, add these once</h3>
      <p className="muted small">So the agent never has to stop the call and ask you. You can still skip them; the call will pause if a rep asks.</p>
      {missing.map((m) => (
        <label key={m.key}>
          {m.label}
          <input type={m.key in SECRET_LABELS ? "password" : "text"} value={vals[m.key] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [m.key]: e.target.value }))} />
        </label>
      ))}
      <div>
        <button className="primary small" onClick={save}>Save</button>
      </div>
    </section>
  );
}

export function CasePage({ state, id, go }: { state: AppState; id: string; go: (r: string) => void }) {
  const c = state.cases.find((x) => x.id === id);
  const [detail, setDetail] = useState<{ calls: CallRow[]; letters: Letter[]; reminders: Reminder[] } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [agree, setAgree] = useState(false);
  const [difficulty, setDifficulty] = useState(state.settings.difficulty);
  const [drafting, setDrafting] = useState<{ kind: LetterKind; text: string } | null>(null);
  const [err, setErr] = useState("");
  const [planning, setPlanning] = useState(false);
  useEffect(() => {
    void api.invoke<typeof detail>("case:detail", id).then(setDetail);
  }, [id, state]);
  useEffect(() => api.on("letter:delta", (d: { caseId: string; kind: LetterKind; text: string }) => d.caseId === id && setDrafting((x) => ({ kind: d.kind, text: (x?.kind === d.kind ? x.text : "") + d.text }))), [id]);
  if (!c) return <div className="page"><p>Case not found.</p></div>;
  const a = state.accounts.find((x) => x.id === c.accountId)!;
  const m = state.merchants.find((x) => x.id === a.merchantId)!;
  const busy = Boolean(state.active);
  const start = async (line: "sim" | "twilio") => {
    setErr("");
    try {
      const callId = await api.invoke<string>("call:start", { caseId: c.id, line, difficulty });
      go(`call/${callId}`);
    } catch (e) {
      setErr(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  const draft = async (kind: LetterKind) => {
    setDrafting({ kind, text: "" });
    await api.invoke("letter:draft", c.id, kind);
    setDrafting(null);
  };
  const l = c.limits;
  return (
    <div className="page">
      <div className="row between">
        <div>
          <div className="muted small">{m.name} · {a.label}</div>
          <h1>{c.goal}</h1>
        </div>
        <span className={`status ${c.status}`}>{STATUS_LABEL[c.status]}</span>
      </div>
      <div className="chips">
        <span className="chip">Now {money(a.monthly, a.monthly % 1 ? 2 : 0)}/mo</span>
        {c.kind === "lower" && <span className="chip">Target {money(l.targetMonthly)}</span>}
        {c.kind === "lower" && <span className="chip">Never above {money(l.maxMonthly)}</span>}
        {c.kind === "lower" && <span className="chip">Contract ≤ {l.maxContractMonths} mo</span>}
        {(c.kind === "refund" || c.kind === "dispute") && <span className="chip">Get back {money(l.refundAmount)}, floor {money(l.minRefund)}</span>}
        <span className="chip">{l.autoAccept ? "Accepts inside limits" : "Asks before accepting"}</span>
        {c.kind === "lower" && <span className="chip">{l.allowCancel ? "Willing to cancel" : "Won't threaten to cancel"}</span>}
        <button className="small link" onClick={() => go(`edit-case/${c.id}`)}>Edit</button>
      </div>

      <MissingInfo c={c} accountId={a.id} saved={a.saved} />

      <div className="grid2">
        <section className="card">
          <div className="row between">
            <h3>The plan</h3>
            <button className="small link" disabled={planning} onClick={async () => { setPlanning(true); await api.invoke("case:plan", c.id).finally(() => setPlanning(false)); }}>{planning ? "Planning" : "Re-plan"}</button>
          </div>
          {c.plan ? (
            <>
              <p className="quote">"{c.plan.opener}"</p>
              <ol className="steps">{c.plan.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              {c.plan.leverage.length > 0 && (
                <>
                  <h4>Leverage</h4>
                  <ul>{c.plan.leverage.map((s) => <li key={s}>{s}</li>)}</ul>
                </>
              )}
              {c.plan.fallbacks.length > 0 && (
                <>
                  <h4>If they won't move</h4>
                  <ul>{c.plan.fallbacks.map((s) => <li key={s}>{s}</li>)}</ul>
                </>
              )}
              {c.plan.risk && <p className="muted small">{c.plan.risk}</p>}
            </>
          ) : (
            <p className="muted">No plan yet.</p>
          )}
        </section>
        <section className="card">
          <h3>Call</h3>
          <p className="muted small">{m.phone ? `${m.name} at ${m.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3")}` : "No number saved for this company yet."} {m.hours && `· ${m.hours}`}</p>
          <div className="row gap wrap">
            <button className="primary" disabled={busy} onClick={() => start("sim")}>Dry run</button>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}>
              <option value="easy">Easy rep</option>
              <option value="normal">Normal rep</option>
              <option value="stubborn">Stubborn rep</option>
            </select>
            <button disabled={busy || !state.settings.liveReady} title={state.settings.liveReady ? "" : `Needs: ${state.settings.missingForLive.join(", ")}`} onClick={() => setConfirm(true)}>Call for real</button>
          </div>
          <p className="muted small">A dry run plays the whole call against a simulated {m.name.split(" (")[0]} phone menu, hold and retention rep, so you can see the strategy before spending a real call. It doesn't count toward savings.</p>
          {!state.settings.liveReady && <p className="muted small">Real calls need {state.settings.missingForLive.join(", ")}. See Settings.</p>}
          {err && <div className="note bad">{err}</div>}
          {confirm && (
            <div className="confirm">
              <p>
                Pushback will call <strong>{m.phone}</strong> from your Twilio number and open with: <em>"{c.plan?.opener ?? "Hi, I'm an AI assistant calling on behalf of the account holder."}"</em>
              </p>
              <p className="muted small">Cost is roughly $0.03 a minute for the phone line and transcription plus the model, so a 30 minute call with hold is about $1 to $2. You'll get a notification when a person picks up or if they need something from you.</p>
              <label className="check">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I'm the account holder (or authorized on the account) and I want Pushback to call for me
              </label>
              <div className="row gap">
                <button className="primary" disabled={!agree} onClick={() => { setConfirm(false); void start("twilio"); }}>Place the call</button>
                <button onClick={() => setConfirm(false)}>Not now</button>
              </div>
            </div>
          )}
        </section>
      </div>

      {detail && detail.calls.length > 0 && (
        <section>
          <h2>Calls</h2>
          <div className="list">
            {detail.calls.map((call) => (
              <div key={call.id} className="item clickable" onClick={() => go(`call/${call.id}`)}>
                <span className={`result ${call.outcome?.result ?? "pending"}`}>{call.outcome?.result ?? call.state}</span>
                <span className="grow">{call.outcome?.summary ?? "In progress"}</span>
                <span className="muted small">{call.line === "sim" ? "dry run" : "real call"}</span>
                <span className="muted small">{ago(call.startedAt)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {detail && detail.reminders.length > 0 && (
        <section>
          <h2>Promises and reminders</h2>
          <div className="list">
            {detail.reminders.map((r) => (
              <div key={r.id} className={`item ${r.done ? "done" : ""}`}>
                <span className="grow">{r.text}</span>
                <span className="muted small">{until(r.due)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Letters</h2>
        <p className="muted small">Drafts for you to review and send yourself. Pushback never sends anything.</p>
        <div className="row gap wrap">
          {LETTERS.filter((x) => x.when.includes(c.kind)).map((x) => (
            <button key={x.kind} className="small" disabled={Boolean(drafting)} onClick={() => draft(x.kind)}>{x.label}</button>
          ))}
        </div>
        {drafting && <pre className="letter streaming">{drafting.text || "Drafting"}</pre>}
        {detail?.letters.map((letter) => <LetterView key={letter.id} letter={letter} />)}
      </section>

      <div className="row gap">
        <button className="danger small" onClick={async () => { await api.invoke("case:delete", c.id); go("cases"); }}>Delete case</button>
      </div>
    </div>
  );
}

function LetterView({ letter }: { letter: Letter }) {
  const [body, setBody] = useState(letter.body);
  return (
    <div className="card letter-card">
      <div className="row between">
        <div>
          <strong>{letter.subject}</strong>
          <div className="muted small">To: {letter.to} · {ago(letter.at)}</div>
        </div>
        <div className="row gap">
          <button className="small" onClick={() => api.invoke("clipboard:write", `${letter.subject}\n\n${body}`)}>Copy</button>
          <button className="small" onClick={() => api.invoke("mail:open", letter.to, letter.subject, body)}>Open in Mail</button>
        </div>
      </div>
      <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
    </div>
  );
}
