import { api, money, until, type AppState, STATUS_LABEL, KIND_LABEL } from "./api.ts";

function opportunity(state: AppState, a: AppState["accounts"][number]) {
  const m = state.merchants.find((x) => x.id === a.merchantId);
  const open = state.cases.find((c) => c.accountId === a.id && !["won", "lost"].includes(c.status));
  const promo = a.promoEnds ? Date.parse(`${a.promoEnds}T12:00:00`) : 0;
  const promoGone = promo && promo < Date.now();
  const promoSoon = promo && !promoGone && promo - Date.now() < 45 * 86400000;
  const nums = (m?.typicalWin.match(/\$(\d+)/g) ?? []).map((x) => Number(x.slice(1)));
  const perMonth = nums.length && /month/.test(m?.typicalWin ?? "") ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;
  const reason = promoGone ? `Promo ended ${new Date(promo).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : promoSoon ? `Promo ends ${until(promo)}` : null;
  return { m, open, reason, perMonth: Math.min(perMonth, a.monthly * 0.6) };
}

export function Home({ state, go }: { state: AppState; go: (r: string) => void }) {
  const t = state.totals;
  const due = state.reminders.filter((r) => r.due < Date.now() + 14 * 86400000);
  const later = state.reminders.filter((r) => r.due >= Date.now() + 14 * 86400000).slice(0, 4);
  const ops = state.accounts.map((a) => ({ a, ...opportunity(state, a) }));
  const possible = ops.reduce((s, o) => s + (o.open || o.reason ? o.perMonth * 12 : 0), 0);
  const recent = state.calls.filter((c) => c.outcome).slice(0, 5);
  if (!state.accounts.length)
    return (
      <div className="page">
        <h1>Make them lower it.</h1>
        <p className="lede">Pushback calls your internet, phone and subscription companies for you. It sits through the phone menu and the hold music, asks for retention, quotes competitor prices, and stops at the limits you set. You only get pulled in if they need something only you have.</p>
        <div className="row gap">
          <button className="primary" onClick={() => go("account/new")}>Add an account</button>
          <button onClick={() => api.invoke("demo:seed")}>Load demo accounts</button>
        </div>
      </div>
    );
  return (
    <div className="page">
      <div className="stats">
        <div className="stat big">
          <div className="label">Saved a year</div>
          <div className="value">{money(t.verified + t.claimed)}</div>
          <div className="muted small">{money(t.verified)} confirmed on a bill, {money(t.claimed)} waiting for the next bill{t.missed ? `, ${money(t.missed)} didn't show up` : ""}</div>
        </div>
        <div className="stat">
          <div className="label">Still on the table</div>
          <div className="value">{money(possible)}</div>
          <div className="muted small">typical wins on your accounts, per year</div>
        </div>
        <div className="stat">
          <div className="label">Calls</div>
          <div className="value">{t.calls}</div>
          <div className="muted small">{t.holdMinutes} min on hold you didn't sit through</div>
        </div>
      </div>

      {state.active && (
        <div className="banner" onClick={() => go(`call/${state.active!.callId}`)}>
          <strong>{state.active.needs.length ? "A call needs you" : "Call in progress"}</strong>
          <span>{state.active.needs[0]?.question ?? "Tap to watch it live."}</span>
        </div>
      )}

      {due.length > 0 && (
        <section>
          <h2>Coming up</h2>
          <div className="list">
            {due.map((r) => (
              <div key={r.id} className="item">
                <span className={`tag ${r.kind}`}>{r.kind === "promo" ? "Promo ending" : r.kind === "credit" ? "Check credit" : r.kind === "cancel-check" ? "Check charges" : r.kind === "price" ? "Price went up" : "Follow up"}</span>
                <span className="grow">{r.text}</span>
                <span className="muted small">{until(r.due)}</span>
                {r.caseId && <button className="small" onClick={() => go(`case/${r.caseId}`)}>Open</button>}
                <button className="small" onClick={() => api.invoke("reminder:done", r.id)}>Done</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Your accounts</h2>
        <div className="cards">
          {ops.map(({ a, m, open, reason, perMonth }) => (
            <div key={a.id} className="card acct">
              <div className="row between">
                <div>
                  <div className="title">{a.label}</div>
                  <div className="muted small">{m?.name ?? a.merchantId}</div>
                </div>
                <div className="price">{money(a.monthly, a.monthly % 1 ? 2 : 0)}<span className="muted small">/mo</span></div>
              </div>
              {reason && <div className="flag">{reason}</div>}
              {perMonth > 0 && !open && <div className="muted small">Typical win: {m?.typicalWin}</div>}
              {open ? (
                <div className="row between">
                  <span className={`status ${open.status}`}>{STATUS_LABEL[open.status]}</span>
                  <button className="small" onClick={() => go(`case/${open.id}`)}>
                    {KIND_LABEL[open.kind]}
                  </button>
                </div>
              ) : (
                <div className="row gap">
                  <button className="small primary" onClick={() => go(`new-case/${a.id}/lower`)}>Lower it</button>
                  <button className="small" onClick={() => go(`new-case/${a.id}/cancel`)}>Cancel it</button>
                  <button className="small" onClick={() => go(`new-case/${a.id}/refund`)}>Refund</button>
                </div>
              )}
            </div>
          ))}
          <button className="card add" onClick={() => go("account/new")}>+ Add an account or import a bill</button>
        </div>
      </section>

      {recent.length > 0 && (
        <section>
          <h2>Recent calls</h2>
          <div className="list">
            {recent.map((c) => {
              const k = state.cases.find((x) => x.id === c.caseId);
              const a = state.accounts.find((x) => x.id === k?.accountId);
              return (
                <div key={c.id} className="item clickable" onClick={() => go(`call/${c.id}`)}>
                  <span className={`result ${c.outcome!.result}`}>{c.outcome!.result}</span>
                  <span className="grow">
                    {a?.label}: {c.outcome!.summary}
                  </span>
                  <span className="muted small">{c.line === "sim" ? "dry run" : "real call"}</span>
                  <span className="muted small">{new Date(c.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {later.length > 0 && (
        <section>
          <h2>Watching</h2>
          <div className="list">
            {later.map((r) => (
              <div key={r.id} className="item">
                <span className="grow">{r.text}</span>
                <span className="muted small">{until(r.due)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
