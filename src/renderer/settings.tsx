import { useState } from "react";
import { api, type AppState } from "./api.ts";

function Secret({ label, field, source, hint }: { label: string; field: string; source: "settings" | "env" | "none"; hint?: string }) {
  const [v, setV] = useState("");
  return (
    <label>
      <span>
        {label} {source !== "none" && <span className="tag ok">{source === "env" ? "from .env" : "saved"}</span>}
      </span>
      <div className="row gap">
        <input className="grow" type="password" value={v} placeholder={source === "none" ? hint ?? "" : "Saved. Type to replace"} onChange={(e) => setV(e.target.value)} />
        <button className="small" disabled={!v} onClick={async () => { await api.invoke("settings:set", { [field]: v }); setV(""); }}>Save</button>
        {source === "settings" && <button className="small" onClick={() => api.invoke("settings:set", { [field]: "" })}>Remove</button>}
      </div>
    </label>
  );
}

function Plain({ label, field, value, hint }: { label: string; field: string; value: string; hint?: string }) {
  const [v, setV] = useState(value);
  return (
    <label>
      {label}
      <div className="row gap">
        <input className="grow" value={v} placeholder={hint} onChange={(e) => setV(e.target.value)} />
        <button className="small" disabled={v === value} onClick={() => api.invoke("settings:set", { [field]: v.trim() })}>Save</button>
      </div>
    </label>
  );
}

export function SettingsPage({ state }: { state: AppState }) {
  const s = state.settings;
  const [tunnel, setTunnel] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="page narrow">
      <h1>Settings</h1>
      <section className={`card form ${s.rehearsal ? "warn" : ""}`}>
        <h3>{s.rehearsal ? "Rehearsal mode" : "Claude is connected"}</h3>
        <p className="muted small">
          {s.rehearsal
            ? "No Anthropic key yet, so Pushback runs a built-in negotiator against simulated reps. Every screen works. Add a key to plan, negotiate, summarize and write letters with Claude."
            : `Using ${s.model} for negotiating (low effort for speed on the phone), planning, summaries and letters.`}
        </p>
        <Secret label="Anthropic API key" field="anthropicKey" source={s.has.anthropicKey} hint="sk-ant-..." />
        <Plain label="Model" field="model" value={s.model} />
      </section>

      <section className="card form">
        <h3>Real calls</h3>
        <p className="muted small">Pushback places calls through your own Twilio number and transcribes and speaks with Deepgram. A Twilio trial account can only call verified numbers, so upgrade it before calling a company.</p>
        <Plain label="Twilio account SID" field="twilioSid" value={s.twilioSid} hint="AC..." />
        <Secret label="Twilio auth token" field="twilioToken" source={s.has.twilioToken} />
        <Plain label="Your Twilio phone number" field="twilioFrom" value={s.twilioFrom} hint="+15555550100" />
        <Secret label="Deepgram API key" field="deepgramKey" source={s.has.deepgramKey} />
        <Plain label="Deepgram voice" field="voice" value={s.voice} />
        <Plain label="Public URL for Twilio to reach this Mac" field="publicUrl" value={s.publicUrl} hint="https://something.trycloudflare.com" />
        <div className="row gap">
          <button className="small" disabled={busy} onClick={async () => { setBusy(true); setTunnel(""); try { setTunnel(await api.invoke<string>("tunnel:start")); } catch (e) { setTunnel(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); } finally { setBusy(false); } }}>{busy ? "Starting" : "Start a cloudflared tunnel"}</button>
          {tunnel && <span className="muted small">{tunnel}</span>}
        </div>
        <Plain label="Your phone (for transferring a call to you)" field="myPhone" value={s.myPhone} hint="+15555550142" />
        <label className="check">
          <input type="checkbox" checked={s.record} onChange={(e) => api.invoke("settings:set", { record: e.target.checked })} /> Record real calls in Twilio (the agent always says the call is recorded)
        </label>
        <div className={`note ${s.liveReady ? "good" : ""}`}>{s.liveReady ? "Ready for real calls." : `Still needed: ${s.missingForLive.join(", ")}.`}</div>
      </section>

      <section className="card form">
        <h3>Dry runs</h3>
        <label>
          Default rep
          <select value={s.difficulty} onChange={(e) => api.invoke("settings:set", { difficulty: e.target.value })}>
            <option value="easy">Easy</option>
            <option value="normal">Normal</option>
            <option value="stubborn">Stubborn (asks the holder to authorize, no promos at first)</option>
          </select>
        </label>
        <label>
          Who plays the rep
          <select value={s.repMode} onChange={(e) => api.invoke("settings:set", { repMode: e.target.value })}>
            <option value="scripted">Scripted rep (fast, free, repeatable)</option>
            <option value="claude" disabled={s.rehearsal}>Claude plays the rep (more realistic, uses your key)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.listen} onChange={(e) => api.invoke("settings:set", { listen: e.target.checked })} /> Read dry runs out loud with system voices
        </label>
      </section>

      <section className="card form">
        <h3>How Pushback behaves on a call</h3>
        <ul className="small">
          <li>It always says it's an AI assistant calling for you, and that the call is recorded.</li>
          <li>It never says a PIN, SSN digits or security answer unless you saved them, and the model never sees them.</li>
          <li>It can't accept a price above your limit or a longer contract than you allowed; those pause the call and ask you.</li>
          <li>It never sends emails or letters. It drafts them for you.</li>
        </ul>
      </section>
    </div>
  );
}
