import { useState } from "react";
import { api, ago, type AppState } from "./api.ts";
import type { Merchant } from "../engine/types.ts";

export function Playbooks({ state, go }: { state: AppState; go: (r: string) => void }) {
  return (
    <div className="page">
      <h1>Playbooks</h1>
      <p className="muted">How each company works: phone menus, what they verify, what gets results. Real calls add what they learn here, so the next call starts smarter.</p>
      <div className="list">
        {state.merchants.map((m) => {
          const learned = state.lessons.filter((l) => l.merchantId === m.id).length;
          return (
            <div key={m.id} className="item clickable" onClick={() => go(`playbook/${m.id}`)}>
              <span className="grow">
                <strong>{m.name}</strong> <span className="muted small">{m.category}</span>
              </span>
              <span className="muted small">{m.typicalWin}</span>
              {learned > 0 && <span className="tag ok">{learned} learned</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function PlaybookEditor({ state, id, go }: { state: AppState; id: string; go: (r: string) => void }) {
  const m = state.merchants.find((x) => x.id === id);
  const [form, setForm] = useState(() => ({
    phone: m?.phone ?? "",
    hours: m?.hours ?? "",
    verification: m?.verification.join("\n") ?? "",
    ivr: m?.ivr.join("\n") ?? "",
    tactics: m?.tactics.join("\n") ?? "",
    competitors: m?.competitors.map((c) => `${c.name}: ${c.offer}`).join("\n") ?? "",
    cancel: m?.cancel ?? "",
    typicalWin: m?.typicalWin ?? "",
  }));
  const [saved, setSaved] = useState(false);
  if (!m) return <div className="page"><p>Not found.</p></div>;
  const learned = state.lessons.filter((l) => l.merchantId === m.id);
  const set = (k: keyof typeof form, v: string) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const save = async () => {
    const next: Merchant = {
      ...m,
      phone: form.phone.replace(/[^\d+]/g, ""),
      hours: form.hours,
      verification: lines(form.verification),
      ivr: lines(form.ivr),
      tactics: lines(form.tactics),
      competitors: lines(form.competitors).map((l) => {
        const [name, ...rest] = l.split(":");
        return { name: name.trim(), offer: rest.join(":").trim() };
      }),
      cancel: form.cancel,
      typicalWin: form.typicalWin,
    };
    await api.invoke("merchant:save", next);
    setSaved(true);
  };
  return (
    <div className="page narrow">
      <h1>{m.name}</h1>
      <section className="card form">
        <div className="row gap">
          <label className="grow">
            Customer service number
            <input value={form.phone} placeholder="+18005551234" onChange={(e) => set("phone", e.target.value)} />
          </label>
          <label className="grow">
            Hours
            <input value={form.hours} onChange={(e) => set("hours", e.target.value)} />
          </label>
        </div>
        <p className="muted small">Check the number against your bill before a real call. Numbers change.</p>
        <label>
          What they verify (one per line)
          <textarea rows={3} value={form.verification} onChange={(e) => set("verification", e.target.value)} />
        </label>
        <label>
          Phone menu notes
          <textarea rows={2} value={form.ivr} onChange={(e) => set("ivr", e.target.value)} />
        </label>
        <label>
          Tactics, in order
          <textarea rows={5} value={form.tactics} onChange={(e) => set("tactics", e.target.value)} />
        </label>
        <label>
          Competitor offers (Name: offer). Check current prices at your address.
          <textarea rows={3} value={form.competitors} onChange={(e) => set("competitors", e.target.value)} />
        </label>
        <label>
          How to cancel
          <input value={form.cancel} onChange={(e) => set("cancel", e.target.value)} />
        </label>
        <label>
          Typical win
          <input value={form.typicalWin} onChange={(e) => set("typicalWin", e.target.value)} />
        </label>
        <div className="row gap">
          <button className="primary" onClick={save}>{saved ? "Saved" : "Save playbook"}</button>
          <button onClick={() => go("playbooks")}>Back</button>
        </div>
      </section>
      <section>
        <h2>Learned from your calls</h2>
        {!learned.length && <p className="muted small">Nothing yet. Each real call adds what worked: the menu path, what unlocked the offer, what failed.</p>}
        <div className="list">
          {learned.map((l) => (
            <div key={l.id} className="item">
              <span className="grow">{l.text}</span>
              <span className="muted small">{ago(l.at)}</span>
              <button className="small" onClick={() => api.invoke("lesson:delete", l.id)}>Remove</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
