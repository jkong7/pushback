import type { CaseKind } from "./types.ts";

export type Heard = "menu" | "speech-menu" | "hold" | "human" | "closed" | "voicemail" | "verify-bot" | "other";

const HOLD = [
  /\b(please (continue to )?hold|remain on the line|stay on the line)\b/i,
  /\byour call is (very )?important\b/i,
  /\b(all of )?our (representatives|agents|associates) are (currently )?(busy|assisting|helping)\b/i,
  /\b(estimated )?wait time\b/i,
  /\b(transferring|connecting) (you|your call)\b/i,
  /\bin the order (it was|they were) received\b/i,
  /\bnext available\b/i,
  /\[(hold music|music)\]/i,
];

const HUMAN = [
  /\b(my name is|this is|you'?ve reached|speaking with) [A-Z][a-z]+/,
  /\bhow (can|may) I (help|assist)\b/i,
  /\bwho (do I have|am I speaking with|am I talking to)\b/i,
  /\bwhat can I do for you\b/i,
  /\bthanks? for (holding|waiting|your patience)\b/i,
  /\bcan I (get|have) (your|the) (name|account)\b/i,
];

const CLOSED = [/\b(we are|we're|our offices are) (currently )?closed\b/i, /\boutside (of )?(our )?(normal )?business hours\b/i];
const VOICEMAIL = [/\bleave (a|your) message\b/i, /\bafter the (tone|beep)\b/i, /\bmailbox is full\b/i];
const VERIFY_BOT = [/\b(enter|say) (your|the) (account|phone) number\b/i, /\b(enter|say) your (pin|passcode|zip)\b/i];

const MENU_ITEM = /(?:(?:for|to)\s+([^,.;]+?),?\s+(?:press|dial|say)\s+(\d|star|pound|zero|one|two|three|four|five|six|seven|eight|nine))|(?:(?:press|dial)\s+(\d|zero|one|two|three|four|five|six|seven|eight|nine)\s+(?:for|to)\s+([^,.;]+))/gi;

const WORD_DIGIT: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", star: "*", pound: "#" };

export interface MenuItem {
  digit: string;
  label: string;
}

export function parseMenu(text: string): MenuItem[] {
  const items: MenuItem[] = [];
  for (const m of text.matchAll(MENU_ITEM)) {
    const label = (m[1] ?? m[4] ?? "").trim().toLowerCase();
    const raw = (m[2] ?? m[3] ?? "").toLowerCase();
    const digit = WORD_DIGIT[raw] ?? raw;
    if (label && digit && !items.some((i) => i.digit === digit)) items.push({ digit, label });
  }
  return items;
}

export function classify(text: string): Heard {
  if (VOICEMAIL.some((r) => r.test(text))) return "voicemail";
  if (CLOSED.some((r) => r.test(text))) return "closed";
  if (parseMenu(text).length >= 2) return "menu";
  if (VERIFY_BOT.some((r) => r.test(text)) && !HUMAN.some((r) => r.test(text))) return "verify-bot";
  if (/\b(tell me|in a few words|briefly describe|what('s| is) the reason)\b.*\b(call|calling)\b/i.test(text) || /\byou can say things like\b/i.test(text)) return "speech-menu";
  if (HUMAN.some((r) => r.test(text))) return "human";
  if (HOLD.some((r) => r.test(text))) return "hold";
  return "other";
}

const INTENT_WORDS: Record<CaseKind, string[][]> = {
  lower: [["cancel", "disconnect", "retention", "loyalty"], ["billing representative", "speak", "representative", "agent"], ["billing", "bill", "account", "subscription"], ["change", "plan", "services", "existing"], ["other", "all other"]],
  cancel: [["cancel", "disconnect", "end service", "close"], ["subscription changes", "existing plan", "change"], ["billing representative", "representative", "team member", "agent", "speak"], ["billing", "account"], ["other", "all other"]],
  refund: [["billing representative", "representative", "speak"], ["billing", "charge", "payment", "refund", "dispute"], ["account", "existing"], ["other", "all other"]],
  dispute: [["dispute", "charge", "billing representative"], ["billing", "payment", "representative"], ["account", "existing"], ["other", "all other"]],
};

const AVOID = /\b(technical|tech support|outage|sales|new service|hours|balance|make a payment|pay my bill|delivery|espa)/i;

export function chooseDigit(items: MenuItem[], kind: CaseKind, tried: string[] = []): MenuItem | null {
  const open = items.filter((i) => !tried.includes(`${i.digit}:${i.label}`));
  for (const tier of INTENT_WORDS[kind]) {
    const hit = open.find((i) => !AVOID.test(i.label) && tier.some((w) => i.label.includes(w)));
    if (hit) return hit;
  }
  return open.find((i) => i.digit === "0") ?? null;
}

export function speechIntent(kind: CaseKind): string {
  return { lower: "Cancel service", cancel: "Cancel service", refund: "Billing question", dispute: "Dispute a charge" }[kind];
}

export function isRepeatedMenu(text: string, seen: string[]): boolean {
  const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 120);
  return seen.includes(norm);
}

export function menuKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 120);
}
