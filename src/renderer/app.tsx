import { createRoot } from "react-dom/client";
import { useAppState, useRoute, money } from "./api.ts";
import { Home } from "./home.tsx";
import { Accounts, AccountEditor } from "./accounts.tsx";
import { CaseEditor, CasePage, Cases } from "./cases.tsx";
import { CallPage } from "./call.tsx";
import { Playbooks, PlaybookEditor } from "./playbooks.tsx";
import { SettingsPage } from "./settings.tsx";

const NAV = [
  ["home", "Home"],
  ["accounts", "Accounts"],
  ["cases", "Cases"],
  ["playbooks", "Playbooks"],
  ["settings", "Settings"],
] as const;

function App() {
  const state = useAppState();
  const [route, go] = useRoute();
  if (!state) return <div className="loading">Loading</div>;
  const [page, id, extra] = route.split("/");
  const live = state.active;
  let body;
  if (page === "accounts") body = <Accounts state={state} go={go} />;
  else if (page === "account") body = <AccountEditor state={state} id={id} go={go} />;
  else if (page === "cases") body = <Cases state={state} go={go} />;
  else if (page === "new-case") body = <CaseEditor state={state} accountId={id} kind={extra} go={go} />;
  else if (page === "edit-case") body = <CaseEditor state={state} caseId={id} go={go} />;
  else if (page === "case") body = <CasePage state={state} id={id} go={go} />;
  else if (page === "call") body = <CallPage state={state} id={id} go={go} />;
  else if (page === "playbooks") body = <Playbooks state={state} go={go} />;
  else if (page === "playbook") body = <PlaybookEditor state={state} id={id} go={go} />;
  else if (page === "settings") body = <SettingsPage state={state} />;
  else body = <Home state={state} go={go} />;
  const section = page === "account" ? "accounts" : ["case", "new-case", "edit-case", "call"].includes(page) ? "cases" : page === "playbook" ? "playbooks" : page;
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="mark">P</span>
          <span>Pushback</span>
        </div>
        <nav>
          {NAV.map(([r, label]) => (
            <a key={r} className={section === r ? "on" : ""} href={`#/${r}`}>
              {label}
            </a>
          ))}
        </nav>
        {live && (
          <a className={`live-pill ${live.needs.length ? "needs" : ""}`} href={`#/call/${live.callId}`}>
            <span className="dot" />
            {live.needs.length ? "Needs you" : live.state === "hold" ? "On hold" : "Call in progress"}
          </a>
        )}
        <div className="side-foot">
          <div className="saved">{money(state.totals.verified + state.totals.claimed)}</div>
          <div className="muted small">saved a year</div>
          <div className={`mode ${state.settings.rehearsal ? "rehearsal" : "live"}`}>{state.settings.rehearsal ? "Rehearsal mode" : `Claude ${state.settings.model.replace("claude-", "")}`}</div>
        </div>
      </aside>
      <main className="main">{body}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
