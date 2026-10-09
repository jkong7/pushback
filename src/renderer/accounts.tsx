import { useState } from "react";
import { api, money, type AppState } from "./api.ts";
import { SECRET_LABELS, type Secret } from "../engine/types.ts";
import type { BillFields } from "../engine/bill.ts";

export function Accounts({ state, go }: { state: AppState; go: (r: string) => void }) {
  return (
    <div className="page">
      <div className="row between">
        <h1>Accounts</h1>
        <button className="primary" onClick={() => go("account/new")}>Add account</button>
      </div>
      <p className="muted">Everything stays on this Mac. PINs and security answers are encrypted with your keychain and are never sent to the model.</p>
      <div className="list">
        {state.accounts.map((a) => {
          const m = state.merchants.find((x) => x.id === a.merchantId);
          return (
            <div key={a.id} className="item clickable" onClick={() => go(`account/${a.id}`)}>
              <span className="grow">
                <strong>{a.label}</strong> <span className="muted">{m?.name}</span>
              </span>
              <span className="muted small">{a.saved.length ? `${a.saved.length} secret${a.saved.length > 1 ? "s" : ""} saved` : "no secrets saved"}</span>
              <span className="price">{money(a.monthly, a.monthly % 1 ? 2 : 0)}/mo</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const EMPTY = { merchantId: "xfinity", label: "", holder: "", accountNumber: "", address: "", phoneOnFile: "", plan: "", monthly: 0, promoEnds: "", notes: "" };

async function readFile(f: File): Promise<{ data: string; mediaType: "image/png" | "image/jpeg" | "application/pdf" } | { text: string }> {
  if (/^text\//.test(f.type) || /\.(txt|csv|eml)$/i.test(f.name)) return { text: await f.text() };
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const mediaType = f.type === "application/pdf" ? "application/pdf" : f.type === "image/png" ? "image/png" : "image/jpeg";
  return { data: btoa(bin), mediaType };
}

export function AccountEditor({ state, id, go }: { state: AppState; id: string; go: (r: string) => void }) {
  const existing = state.accounts.find((a) => a.id === id);
  const [form, setForm] = useState({ ...EMPTY, ...(existing ?? {}), promoEnds: existing?.promoEnds ?? "" });
  const [secrets, setSecrets] = useState<Partial<Record<Secret, string>>>({});
  const [billText, setBillText] = useState("");
  const [reading, setReading] = useState(false);
  const [billMsg, setBillMsg] = useState<string[]>([]);
  const [tips, setTips] = useState<{ label: string; amount: number; tip: string }[]>([]);
  const [lastBill, setLastBill] = useState<BillFields | null>(null);
  const set = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  const read = async (input: { text?: string; file?: unknown }) => {
    setReading(true);
    setBillMsg([]);
    try {
      const r = await api.invoke<{ fields: BillFields; merchantId: string; tips: typeof tips }>("bill:read", input);
      const f = r.fields;
      setLastBill(f);
      setTips(r.tips);
      setForm((x) => ({
        ...x,
        merchantId: existing ? x.merchantId : r.merchantId,
        label: x.label || (state.merchants.find((m) => m.id === r.merchantId)?.category === "internet" ? "Home internet" : f.merchant ?? ""),
        holder: x.holder || f.holder || "",
        accountNumber: x.accountNumber || f.accountNumber || "",
        address: x.address || f.address || "",
        plan: f.plan || x.plan,
        monthly: existing ? x.monthly : f.monthly ?? x.monthly,
        promoEnds: f.promoEnds || x.promoEnds,
      }));
      setBillMsg([`Read ${[f.merchant, f.monthly != null ? money(f.monthly, 2) : null, f.accountNumber ? "account number" : null, f.promoEnds ? `promo end ${f.promoEnds}` : null].filter(Boolean).join(", ") || "nothing useful"}. Check the fields below.`]);
    } catch (e) {
      setBillMsg([String((e as Error).message)]);
    } finally {
      setReading(false);
    }
  };

  const save = async () => {
    const newId = await api.invoke<string>("account:save", { ...existing, ...form, id: existing?.id, monthly: Number(form.monthly) || 0, promoEnds: form.promoEnds || null, secrets });
    if (existing && lastBill) {
      const msgs = await api.invoke<string[]>("bill:apply", newId, lastBill);
      if (msgs.length) {
        setBillMsg(msgs);
        setLastBill(null);
        return;
      }
    }
    go(existing ? `account/${newId}` : "home");
  };

  const merchant = state.merchants.find((m) => m.id === form.merchantId);
  const needed = new Set<Secret>(merchant?.sim.requires ?? []);
  for (const v of merchant?.verification ?? []) {
    if (/pin|passcode/i.test(v)) needed.add("pin");
    if (/ssn/i.test(v)) needed.add("last4");
  }

  return (
    <div className="page narrow">
      <h1>{existing ? existing.label : "Add an account"}</h1>
      <section className="card">
        <h3>{existing ? "Import this month's bill" : "Start from a bill"}</h3>
        <p className="muted small">{existing ? "Pushback checks the new amount against what reps promised and flags price hikes." : "Drop a PDF or screenshot, or paste the text. Fields fill in below for you to check."}</p>
        <textarea rows={4} placeholder="Paste bill text here" value={billText} onChange={(e) => setBillText(e.target.value)} />
        <div className="row gap">
          <button disabled={!billText.trim() || reading} onClick={() => read({ text: billText })}>{reading ? "Reading" : "Read pasted text"}</button>
          <label className="button">
            Choose PDF or image
            <input type="file" accept=".pdf,image/*,.txt" hidden onChange={async (e) => e.target.files?.[0] && read(await readFile(e.target.files[0]).then((r) => ("text" in r ? { text: r.text } : { file: r })))} />
          </label>
        </div>
        {billMsg.map((m) => (
          <div key={m} className="note">{m}</div>
        ))}
        {tips.map((t) => (
          <div key={t.label} className="note good">
            {t.label} costs {money(t.amount, 2)} a month. {t.tip}.
          </div>
        ))}
      </section>

      <section className="card form">
        <label>
          Company
          <select value={form.merchantId} onChange={(e) => set("merchantId", e.target.value)}>
            {state.merchants.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label>
          Nickname
          <input value={form.label} placeholder="Home internet" onChange={(e) => set("label", e.target.value)} />
        </label>
        <label>
          Name on the account
          <input value={form.holder} onChange={(e) => set("holder", e.target.value)} />
        </label>
        <label>
          Account number
          <input value={form.accountNumber} onChange={(e) => set("accountNumber", e.target.value)} />
        </label>
        <label>
          Service address
          <input value={form.address} onChange={(e) => set("address", e.target.value)} />
        </label>
        <label>
          Phone number on the account
          <input value={form.phoneOnFile} onChange={(e) => set("phoneOnFile", e.target.value)} />
        </label>
        <label>
          Plan
          <input value={form.plan} onChange={(e) => set("plan", e.target.value)} />
        </label>
        <div className="row gap">
          <label className="grow">
            Monthly price
            <input type="number" step="0.01" value={form.monthly || ""} onChange={(e) => set("monthly", e.target.value)} />
          </label>
          <label className="grow">
            Promo ends
            <input type="date" value={form.promoEnds ?? ""} onChange={(e) => set("promoEnds", e.target.value)} />
          </label>
        </div>
        <label>
          Notes for the agent
          <textarea rows={2} value={form.notes} placeholder="Customer since 2019, had two outages in August" onChange={(e) => set("notes", e.target.value)} />
        </label>
      </section>

      <section className="card form">
        <h3>Verification</h3>
        <p className="muted small">Saved once, so a rep asking for them never stops the call. The agent only ever sees a placeholder like {"{{pin}}"}; the real value is filled in on your Mac right before it's spoken.</p>
        {(Object.keys(SECRET_LABELS) as Secret[]).map((k) => {
          const saved = existing?.saved.includes(k);
          return (
            <label key={k}>
              <span>
                {SECRET_LABELS[k]} {needed.has(k) && <span className="tag">{merchant?.name.split(" (")[0]} asks for this</span>} {saved && <span className="tag ok">saved</span>}
              </span>
              <div className="row gap">
                <input className="grow" type="password" autoComplete="off" placeholder={saved ? "Saved. Type to replace" : ""} value={secrets[k] ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, [k]: e.target.value }))} />
                {saved && <button className="small" onClick={() => api.invoke("account:clearSecret", existing!.id, k)}>Forget</button>}
              </div>
            </label>
          );
        })}
      </section>

      <div className="row gap">
        <button className="primary" disabled={!form.label || !form.holder} onClick={save}>Save</button>
        {existing && (
          <>
            <button onClick={() => go(`new-case/${existing.id}/lower`)}>New case</button>
            <button className="danger" onClick={async () => { await api.invoke("account:delete", existing.id); go("accounts"); }}>Delete account</button>
          </>
        )}
      </div>
    </div>
  );
}
