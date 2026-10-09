import { useEffect, useMemo, useRef, useState } from "react";
import { api, money, type AppState } from "./api.ts";
import type { CallEvent, CallRow, Need, Offer, Outcome } from "../engine/types.ts";
import { effectiveMonthly, withinLimits } from "../engine/offers.ts";

const PHASES = [
  ["dialing", "Dialing"],
  ["ivr", "Phone menu"],
  ["hold", "On hold"],
  ["human", "Talking"],
  ["wrapup", "Wrap-up"],
] as const;

const STATE_OF: Record<string, string> = { Dialing: "dialing", "Phone menu": "ivr", "On hold": "hold", "Talking to a person": "human", "Wrapping up": "wrapup", "Call ended": "ended" };

function speak(text: string, who: "agent" | "them") {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text.replace(/\{\{[a-z0-9_]+\}\}/g, "one two three four"));
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  u.voice = (who === "agent" ? voices.find((v) => /Samantha|Ava|Allison/.test(v.name)) : voices.find((v) => /Daniel|Fred|Tom|Alex/.test(v.name))) ?? null;
  u.rate = 1.1;
  speechSynthesis.speak(u);
}

export function CallPage({ state, id, go }: { state: AppState; id: string; go: (r: string) => void }) {
  const live = state.active?.callId === id ? state.active : null;
  const [stored, setStored] = useState<(CallRow & { events: CallEvent[] }) | null>(null);
  const [events, setEvents] = useState<CallEvent[]>(live?.events ?? []);
  const [partial, setPartial] = useState("");
  const [needs, setNeeds] = useState<Need[]>(live?.needs ?? []);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [line, setLine] = useState("");
  const [answer, setAnswer] = useState("");
  const [card, setCard] = useState<{ path: string; dataUrl: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const listen = useRef(state.settings.listen);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listen.current = state.settings.listen;
  }, [state.settings.listen]);

  useEffect(() => {
    setOutcome(null);
    setCard(null);
    if (!live) void api.invoke<CallRow & { events: CallEvent[] }>("call:get", id).then((c) => {
      setStored(c);
      if (c) {
        setEvents(c.events);
        setOutcome(c.outcome);
      }
    });
    else {
      setEvents(live.events);
      setNeeds(live.needs);
    }
    const offs = [
      api.on("call:event", (e: CallEvent) => {
        if (e.callId !== id) return;
        if (e.kind === "partial") return setPartial(e.text);
        if (e.kind === "them") setPartial("");
        if (listen.current && (e.kind === "agent" || e.kind === "them")) speak(e.text, e.kind);
        setEvents((x) => (x.some((y) => y.id === e.id) ? x : [...x, e]));
      }),
      api.on("call:need", (n: Need) => setNeeds((x) => [...x, n])),
      api.on("call:resolved", (nid: string) => setNeeds((x) => x.filter((n) => n.id !== nid))),
      api.on("call:ended", (p: { callId: string; outcome: Outcome }) => {
        if (p.callId !== id) return;
        setOutcome(p.outcome);
        setNeeds([]);
        setPartial("");
        void api.invoke<CallRow & { events: CallEvent[] }>("call:get", id).then(setStored);
      }),
    ];
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      offs.forEach((o) => o());
      clearInterval(t);
    };
  }, [id, Boolean(live)]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length, partial]);

  const caseId = live?.caseId ?? stored?.caseId;
  const c = state.cases.find((x) => x.id === caseId);
  const a = state.accounts.find((x) => x.id === c?.accountId);
  const m = state.merchants.find((x) => x.id === a?.merchantId);
  const phase = useMemo(() => {
    const s = [...events].reverse().find((e) => e.kind === "state");
    return s ? STATE_OF[s.text] ?? "dialing" : "dialing";
  }, [events]);
  const holdStart = useMemo(() => [...events].reverse().find((e) => e.kind === "state" && e.text === "On hold")?.at ?? 0, [events]);
  const started = events[0]?.at ?? now;
  const ended = phase === "ended" || Boolean(outcome);
  const offers = events.filter((e) => e.kind === "offer").map((e) => e.data as Offer);
  const kindOf = (e: CallEvent) => (e.kind === "agent" && (e.data as { byUser?: boolean })?.byUser ? "agent you" : e.kind);
  const elapsed = Math.max(0, Math.round(((ended ? events.at(-1)?.at ?? now : now) - started) / 1000));
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const isSim = (live?.line ?? stored?.line) === "sim";

  return (
    <div className="page call">
      <div className="row between">
        <div>
          <div className="muted small">{m?.name} · {a?.label} · {isSim ? "dry run against a simulated rep" : "real call"}</div>
          <h1>{c?.goal ?? "Call"}</h1>
        </div>
        <div className="timer">{fmt(elapsed)}</div>
      </div>
      <div className="phases">
        {PHASES.map(([k, label]) => {
          const idx = PHASES.findIndex((p) => p[0] === phase);
          const mine = PHASES.findIndex((p) => p[0] === k);
          return (
            <div key={k} className={`phase ${k === phase ? "on" : ""} ${ended || mine < idx ? "past" : ""}`}>
              {label}
              {k === "hold" && phase === "hold" && holdStart ? ` ${fmt(Math.round((now - holdStart) / 1000))}` : ""}
            </div>
          );
        })}
      </div>
      <div className="call-grid">
        <div className="transcript">
          {events
            .filter((e) => !["state", "offer"].includes(e.kind))
            .map((e) => (
              <div key={e.id} className={`ev ${kindOf(e)}`}>
                {e.kind === "them" && <div className="who">{phase === "ivr" || /press|para español|your call is important/i.test(e.text) ? m?.name.split(" (")[0] : "Them"}</div>}
                {e.kind === "agent" && <div className="who">{kindOf(e) === "agent you" ? "You (through Pushback)" : "Pushback"}</div>}
                <div className="text">{e.kind === "agent" ? e.text.split(/(\{\{[a-z0-9_]+\}\})/).map((p, i) => (/^\{\{/.test(p) ? <span key={i} className="secret" title="Filled in locally, never seen by the model">{p.replace(/[{}]/g, "").replace("_", " ")}</span> : p)) : e.text}</div>
              </div>
            ))}
          {partial && !ended && (
            <div className="ev them partial">
              <div className="text">{partial}</div>
            </div>
          )}
          <div ref={bottom} />
        </div>
        <div className="side-panel">
          {needs.map((n) => (
            <div key={n.id} className="card need">
              <div className="label">Needs you</div>
              <p>{n.question}</p>
              {n.kind === "approval" ? (
                <div className="row gap">
                  <button className="primary" onClick={() => api.invoke("call:approve", n.id, true)}>Accept it</button>
                  <button onClick={() => api.invoke("call:approve", n.id, false)}>Push back</button>
                </div>
              ) : (
                <form className="row gap" onSubmit={(e) => { e.preventDefault(); void api.invoke("call:answer", n.id, answer); setAnswer(""); }}>
                  <input className="grow" autoFocus type={n.secret ? "password" : "text"} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={n.secret ? "Kept on this Mac" : "Your answer"} />
                  <button className="primary">Send</button>
                </form>
              )}
              {n.secret && <p className="muted small">The agent gets a placeholder, the value is filled in right before it's spoken.</p>}
            </div>
          ))}

          {outcome && (
            <div className={`card outcome ${outcome.result}`}>
              <div className="label">{isSim ? "Dry run result" : "Result"}</div>
              <h2>{outcome.summary}</h2>
              {outcome.newMonthly != null && outcome.oldMonthly != null && outcome.newMonthly < outcome.oldMonthly && (
                <div className="savings">
                  <span className="old">{money(outcome.oldMonthly, 2)}</span> → <span className="new">{money(outcome.newMonthly, 2)}</span>
                  <div className="muted small">{money((outcome.oldMonthly - outcome.newMonthly) * Math.min(12, outcome.months ?? 12))} over the next {Math.min(12, outcome.months ?? 12)} months{isSim ? " if a real call goes the same way" : ", marked confirmed once a bill shows it"}</div>
                </div>
              )}
              <dl>
                {outcome.confirmation && (<><dt>Confirmation</dt><dd>{outcome.confirmation}</dd></>)}
                {outcome.repName && (<><dt>Rep</dt><dd>{outcome.repName}</dd></>)}
                {outcome.promoEnds && (<><dt>Rate good until</dt><dd>{outcome.promoEnds}</dd></>)}
              </dl>
              {outcome.promises.length > 0 && (
                <>
                  <h4>They promised</h4>
                  <ul>{outcome.promises.map((p) => <li key={p.text}>{p.text}{p.due ? ` (by ${p.due})` : ""}</li>)}</ul>
                </>
              )}
              {outcome.nextSteps.length > 0 && (
                <>
                  <h4>Next</h4>
                  <ul>{outcome.nextSteps.map((p) => <li key={p}>{p}</li>)}</ul>
                </>
              )}
              {outcome.lessons.length > 0 && (
                <>
                  <h4>{isSim ? "What a real call would teach the playbook" : "Added to the playbook"}</h4>
                  <ul>{outcome.lessons.map((p) => <li key={p}>{p}</li>)}</ul>
                </>
              )}
              <div className="row gap wrap">
                {(outcome.newMonthly != null || outcome.credit > 0 || outcome.result === "cancelled") && <button className="small" onClick={async () => setCard(await api.invoke("share:card", id))}>Make a share card</button>}
                {c && <button className="small" onClick={() => go(`case/${c.id}`)}>Back to the case</button>}
              </div>
              {card && (
                <div className="share">
                  <img src={card.dataUrl} alt="Share card" />
                  <button className="small link" onClick={() => api.invoke("file:reveal", card.path)}>Show in Finder</button>
                </div>
              )}
            </div>
          )}

          {c && (
            <div className="card">
              <div className="label">Limits</div>
              {c.kind === "lower" && <p>Target {money(c.limits.targetMonthly)}, never above {money(c.limits.maxMonthly)}, contract up to {c.limits.maxContractMonths} months.</p>}
              {c.kind === "cancel" && <p>Cancel. Decline save offers{c.limits.allowDowngrade ? ` unless it's under ${money(c.limits.maxMonthly)}` : ""}.</p>}
              {(c.kind === "refund" || c.kind === "dispute") && <p>Get back {money(c.limits.refundAmount)}, accept no less than {money(c.limits.minRefund)}.</p>}
              {offers.length > 0 && (
                <>
                  <div className="label">Offers so far</div>
                  {offers.map((o, i) => {
                    const ok = a && withinLimits(c.kind, o, c.limits, a.monthly).ok;
                    const per = a ? effectiveMonthly(o, a.monthly) : o.monthly;
                    return (
                      <div key={i} className={`offer ${ok ? "ok" : "no"}`}>
                        <span>{per != null ? `${money(per)}/mo` : o.credit ? `${money(o.credit)} credit` : o.description.slice(0, 40)}{o.months ? ` · ${o.months} mo` : ""}</span>
                        <span className="small">{ok ? "inside limits" : "outside limits"}</span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {live && !ended && (
            <div className="card controls">
              <form className="row gap" onSubmit={(e) => { e.preventDefault(); void api.invoke("call:say", line); setLine(""); }}>
                <input className="grow" value={line} onChange={(e) => setLine(e.target.value)} placeholder="Type something for Pushback to say" />
                <button>Say</button>
              </form>
              <div className="row gap wrap">
                <button className="small" onClick={() => api.invoke("call:pause", !live.paused)}>{live.paused ? "Hand back to Pushback" : "Take over"}</button>
                {!isSim && <button className="small" onClick={() => api.invoke("call:handoff")}>Transfer to my phone</button>}
                <button className="small" onClick={() => api.invoke("settings:set", { listen: !state.settings.listen })}>{state.settings.listen ? "Mute" : "Listen"}</button>
                <button className="small danger" onClick={() => api.invoke("call:hangup")}>Hang up</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
