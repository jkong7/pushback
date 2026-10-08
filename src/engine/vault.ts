import type { Account, Secret } from "./types.ts";

const PATTERNS: [RegExp, string][] = [
  [/\b(?:\d[ -]?){13,19}\b/g, "[card number]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/\bsk-[a-zA-Z0-9_-]{16,}\b/g, "[api key]"],
  [/\b(password|passcode|pwd)\s*(is|:)\s*\S+/gi, "$1 $2 [hidden]"],
];

export function redact(text: string): string {
  return PATTERNS.reduce((t, [re, sub]) => t.replace(re, sub), text);
}

export const PLACEHOLDERS: Record<string, string> = {
  "{{pin}}": "the account PIN or passcode",
  "{{last4}}": "the last 4 digits of the holder's SSN",
  "{{security}}": "the answer to the security question",
  "{{dob}}": "the holder's date of birth",
  "{{account_number}}": "the full account number",
  "{{address}}": "the service address",
  "{{phone}}": "the phone number on the account",
};

const SECRET_KEYS: Secret[] = ["pin", "last4", "security", "dob"];

export class Vault {
  private values: Record<string, string> = {};

  constructor(account: Account, extra: Record<string, string> = {}) {
    for (const k of SECRET_KEYS) if (account.secrets[k]) this.values[`{{${k}}}`] = account.secrets[k]!;
    if (account.accountNumber) this.values["{{account_number}}"] = account.accountNumber;
    if (account.address) this.values["{{address}}"] = account.address;
    if (account.phoneOnFile) this.values["{{phone}}"] = account.phoneOnFile;
    for (const [k, v] of Object.entries(extra)) this.add(k, v);
  }

  add(key: string, value: string) {
    const k = key.startsWith("{{") ? key : `{{${key}}}`;
    if (value.trim()) this.values[k] = value.trim();
  }

  has(key: string) {
    return Boolean(this.values[key.startsWith("{{") ? key : `{{${key}}}`]);
  }

  available(): string[] {
    return Object.keys(this.values);
  }

  fill(text: string): { text: string; missing: string[] } {
    const missing: string[] = [];
    const out = text.replace(/\{\{[a-z0-9_]+\}\}/g, (m) => {
      const v = this.values[m];
      if (v) return spell(m, v);
      missing.push(m);
      return m;
    });
    return { text: out, missing };
  }

  mask(text: string): string {
    let out = text;
    const entries = Object.entries(this.values).sort((a, b) => b[1].length - a[1].length);
    for (const [k, v] of entries) {
      if (v.length < 3) continue;
      out = out.split(v).join(k);
      const digits = v.replace(/\D/g, "");
      if (digits.length >= 4 && digits !== v) out = out.replace(new RegExp(digits.split("").join("[\\s-]?"), "g"), k);
      const spoken = digits.length >= 3 ? digits.split("").join(" ") : "";
      if (spoken) out = out.split(spoken).join(k);
    }
    return redact(out);
  }
}

function spell(key: string, value: string): string {
  if (key === "{{address}}") return value;
  if (/^\d+$/.test(value) && value.length <= 12) return value.split("").join(" ");
  return value;
}

export function maskAccountNumber(n: string): string {
  const d = n.replace(/\s/g, "");
  return d.length > 4 ? `ending in ${d.slice(-4)}` : d ? "on file" : "unknown";
}
