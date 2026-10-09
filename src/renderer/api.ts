import { useEffect, useState } from "react";
import type { Account, CallEvent, CallRow, Case, Lesson, Merchant, Need, Reminder, Secret } from "../engine/types.ts";
import type { Saving } from "../engine/store.ts";
import type { PublicSettings } from "../main/config.ts";

declare global {
  interface Window {
    pushback: {
      invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
      on(channel: string, fn: (payload: any) => void): () => void;
    };
  }
}

export type AccountView = Omit<Account, "secrets"> & { saved: Secret[] };

export interface AppState {
  settings: PublicSettings;
  accounts: AccountView[];
  merchants: Merchant[];
  cases: Case[];
  calls: CallRow[];
  reminders: Reminder[];
  savings: Saving[];
  totals: { verified: number; claimed: number; missed: number; calls: number; holdMinutes: number; wins: number };
  lessons: Lesson[];
  active: { callId: string; caseId: string; state: string; events: CallEvent[]; needs: Need[]; paused: boolean; line: "sim" | "twilio" } | null;
}

export const api = {
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => window.pushback.invoke<T>(channel, ...args),
  on: (channel: string, fn: (p: any) => void) => window.pushback.on(channel, fn),
};

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    void api.invoke<AppState>("state:get").then(setState);
    return api.on("state", setState);
  }, []);
  return state;
}

export function useRoute(): [string, (r: string) => void] {
  const read = () => decodeURIComponent(location.hash.replace(/^#\/?/, "")) || "home";
  const [route, setRoute] = useState(read());
  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener("hashchange", onHash);
    const off = api.on("nav", (r: string) => (location.hash = `#/${r}`));
    return () => {
      window.removeEventListener("hashchange", onHash);
      off();
    };
  }, []);
  return [route, (r: string) => (location.hash = `#/${r}`)];
}

export const money = (n: number | null | undefined, digits = 0) => (n == null ? "?" : `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);

export const ago = (t: number) => {
  const d = Date.now() - t;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.round(d / 60000)} min ago`;
  if (d < 86400000) return `${Math.round(d / 3600000)} h ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export const until = (t: number) => {
  const d = t - Date.now();
  if (d <= 0) return "due now";
  if (d < 86400000) return "today";
  const days = Math.round(d / 86400000);
  return days < 45 ? `in ${days} days` : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export const KIND_LABEL: Record<Case["kind"], string> = { lower: "Lower the bill", cancel: "Cancel", refund: "Get a refund", dispute: "Dispute a charge" };

export const STATUS_LABEL: Record<Case["status"], string> = { draft: "Needs details", ready: "Ready to call", calling: "On a call", "needs-you": "Needs you", won: "Won", partial: "Partial win", lost: "No deal yet", "follow-up": "Follow up" };
