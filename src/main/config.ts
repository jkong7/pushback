import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import type { Store, Cipher } from "../engine/store.ts";

export function loadEnvFile(dir: string) {
  const file = join(dir, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export const keychain: Cipher = {
  encrypt: (s) => (safeStorage.isEncryptionAvailable() ? `k:${safeStorage.encryptString(s).toString("base64")}` : s),
  decrypt: (s) => {
    if (!s.startsWith("k:")) return s;
    try {
      return safeStorage.decryptString(Buffer.from(s.slice(2), "base64"));
    } catch {
      return "";
    }
  },
};

export interface Settings {
  anthropicKey: string;
  model: string;
  twilioSid: string;
  twilioToken: string;
  twilioFrom: string;
  deepgramKey: string;
  publicUrl: string;
  myPhone: string;
  voice: string;
  record: boolean;
  repMode: "scripted" | "claude";
  difficulty: "easy" | "normal" | "stubborn";
  listen: boolean;
}

type SecretKey = "anthropicKey" | "twilioToken" | "deepgramKey";
const SECRETS: Record<SecretKey, string> = { anthropicKey: "ANTHROPIC_API_KEY", twilioToken: "TWILIO_AUTH_TOKEN", deepgramKey: "DEEPGRAM_API_KEY" };
const PLAIN_ENV: Partial<Record<keyof Settings, string>> = { twilioSid: "TWILIO_ACCOUNT_SID", twilioFrom: "TWILIO_FROM_NUMBER", publicUrl: "PUSHBACK_PUBLIC_URL", myPhone: "PUSHBACK_MY_PHONE", model: "PUSHBACK_MODEL" };

export interface PublicSettings extends Omit<Settings, SecretKey> {
  has: Record<SecretKey, "settings" | "env" | "none">;
  rehearsal: boolean;
  liveReady: boolean;
  missingForLive: string[];
}

const secret = (store: Store, key: string) => keychain.decrypt(store.getSetting(key) ?? "");

export function readSettings(store: Store): Settings {
  const str = (k: keyof Settings, d = "") => store.getSetting(k) ?? (PLAIN_ENV[k] ? process.env[PLAIN_ENV[k]!] : undefined) ?? d;
  const flag = (k: keyof Settings, d: boolean) => {
    const v = store.getSetting(k);
    return v === null ? d : v === "1";
  };
  return {
    anthropicKey: secret(store, "anthropicKey") || process.env.ANTHROPIC_API_KEY || "",
    twilioToken: secret(store, "twilioToken") || process.env.TWILIO_AUTH_TOKEN || "",
    deepgramKey: secret(store, "deepgramKey") || process.env.DEEPGRAM_API_KEY || "",
    model: str("model", "claude-opus-5-5"),
    twilioSid: str("twilioSid"),
    twilioFrom: str("twilioFrom"),
    publicUrl: str("publicUrl"),
    myPhone: str("myPhone"),
    voice: str("voice", "aura-2-thalia-en"),
    record: flag("record", true),
    repMode: str("repMode", "scripted") as Settings["repMode"],
    difficulty: str("difficulty", "normal") as Settings["difficulty"],
    listen: flag("listen", false),
  };
}

export function isRehearsal(s: Settings) {
  return process.env.PUSHBACK_REHEARSAL === "1" || !s.anthropicKey;
}

export function publicSettings(store: Store): PublicSettings {
  const s = readSettings(store);
  const src = (k: SecretKey) => (store.getSetting(k) ? "settings" : process.env[SECRETS[k]] ? "env" : "none") as "settings" | "env" | "none";
  const missing: string[] = [];
  if (!s.twilioSid) missing.push("Twilio account SID");
  if (!s.twilioToken) missing.push("Twilio auth token");
  if (!s.twilioFrom) missing.push("Twilio phone number");
  if (!s.deepgramKey) missing.push("Deepgram key");
  if (!s.publicUrl) missing.push("Public URL (start a tunnel)");
  if (isRehearsal(s)) missing.push("Anthropic key");
  const { anthropicKey: _a, twilioToken: _t, deepgramKey: _d, ...rest } = s;
  return { ...rest, has: { anthropicKey: src("anthropicKey"), twilioToken: src("twilioToken"), deepgramKey: src("deepgramKey") }, rehearsal: isRehearsal(s), liveReady: missing.length === 0, missingForLive: missing };
}

export function writeSettings(store: Store, patch: Partial<Settings>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k in SECRETS) store.setSetting(k, v ? keychain.encrypt(String(v)) : "");
    else if (typeof v === "boolean") store.setSetting(k, v ? "1" : "0");
    else store.setSetting(k, String(v));
  }
}
