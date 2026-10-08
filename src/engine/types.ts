export type Effort = "low" | "medium" | "high" | "max";

export type BrainTask = "turn" | "rep" | "plan" | "outcome" | "letter" | "bill" | "ivr";

export interface BrainRequest {
  task: BrainTask;
  system: string;
  context: string;
  prompt: string;
  image?: { data: string; mediaType: "image/png" | "image/jpeg" | "application/pdf" };
  effort?: Effort;
  maxTokens?: number;
  data?: unknown;
}

export interface Brain {
  readonly name: string;
  stream(req: BrainRequest, onText: (text: string) => void, signal?: AbortSignal): Promise<string>;
  json<T>(req: BrainRequest, schema: Record<string, unknown>): Promise<T>;
}

export type Category = "internet" | "wireless" | "tv" | "streaming" | "gym" | "news" | "software" | "insurance" | "utility" | "airline" | "other";

export interface MenuOption {
  digit: string;
  label: string;
  next?: SimMenu | "hold" | "retention" | "billing" | "cancel";
}

export interface SimMenu {
  prompt: string;
  options: MenuOption[];
  speech?: boolean;
}

export interface SimOffer {
  monthly: number;
  months: number;
  description: string;
  unlock: "ask" | "competitor" | "cancel" | "loyalty" | "supervisor";
}

export interface SimProfile {
  menu: SimMenu;
  holdSeconds: number;
  repNames: string[];
  requires: Secret[];
  offers: SimOffer[];
  saveAttempts: number;
  refundRate: number;
}

export interface Merchant {
  id: string;
  name: string;
  category: Category;
  phone: string;
  hours: string;
  verification: string[];
  ivr: string[];
  tactics: string[];
  competitors: { name: string; offer: string }[];
  cancel: string;
  written?: { email?: string; address?: string; url?: string };
  typicalWin: string;
  sim: SimProfile;
  builtin?: boolean;
}

export type Secret = "pin" | "last4" | "security" | "dob";

export const SECRET_LABELS: Record<Secret, string> = {
  pin: "Account PIN or passcode",
  last4: "Last 4 of SSN",
  security: "Security question answer",
  dob: "Date of birth",
};

export interface Account {
  id: string;
  merchantId: string;
  label: string;
  holder: string;
  accountNumber: string;
  address: string;
  phoneOnFile: string;
  plan: string;
  monthly: number;
  promoEnds: string | null;
  notes: string;
  secrets: Partial<Record<Secret, string>>;
  createdAt: number;
}

export type CaseKind = "lower" | "cancel" | "refund" | "dispute";

export type CaseStatus = "draft" | "ready" | "calling" | "needs-you" | "won" | "partial" | "lost" | "follow-up";

export interface Limits {
  targetMonthly: number | null;
  maxMonthly: number | null;
  maxContractMonths: number;
  allowCancel: boolean;
  allowDowngrade: boolean;
  refundAmount: number | null;
  minRefund: number | null;
  autoAccept: boolean;
}

export interface Plan {
  opener: string;
  steps: string[];
  leverage: string[];
  asks: string[];
  fallbacks: string[];
  missing: { key: string; label: string }[];
  risk: string;
}

export interface Case {
  id: string;
  accountId: string;
  kind: CaseKind;
  goal: string;
  details: string;
  limits: Limits;
  status: CaseStatus;
  plan: Plan | null;
  createdAt: number;
  updatedAt: number;
}

export interface Offer {
  monthly: number | null;
  months: number | null;
  credit: number | null;
  description: string;
}

export interface Commitment {
  text: string;
  due: string | null;
}

export type OutcomeResult = "won" | "partial" | "lost" | "cancelled" | "refunded" | "no-answer";

export interface Outcome {
  result: OutcomeResult;
  summary: string;
  oldMonthly: number | null;
  newMonthly: number | null;
  months: number | null;
  credit: number;
  promoEnds: string | null;
  confirmation: string | null;
  repName: string | null;
  promises: Commitment[];
  nextSteps: string[];
  lessons: string[];
}

export type CallState = "dialing" | "ivr" | "hold" | "human" | "wrapup" | "ended";

export type EventKind = "them" | "agent" | "digits" | "system" | "user" | "state" | "offer" | "needs" | "answer" | "partial";

export interface CallEvent {
  id: string;
  callId: string;
  at: number;
  kind: EventKind;
  text: string;
  data?: unknown;
}

export interface CallRow {
  id: string;
  caseId: string;
  line: "sim" | "twilio";
  startedAt: number;
  endedAt: number | null;
  state: CallState;
  outcome: Outcome | null;
  holdMs: number;
}

export interface Reminder {
  id: string;
  caseId: string | null;
  accountId: string;
  due: number;
  kind: "promo" | "credit" | "cancel-check" | "follow-up" | "price";
  text: string;
  done: boolean;
}

export interface Lesson {
  id: string;
  merchantId: string;
  text: string;
  at: number;
  callId: string | null;
}

export interface Letter {
  id: string;
  caseId: string;
  kind: LetterKind;
  subject: string;
  to: string;
  body: string;
  at: number;
}

export type LetterKind = "cancel" | "complaint" | "chargeback" | "refund" | "follow-up";

export type AgentAction = "say" | "press" | "wait" | "ask_user" | "hang_up";

export interface AgentTurn {
  action: AgentAction;
  say: string;
  digits: string;
  question: string;
  secret: boolean;
  offer: Offer | null;
  decision: "accept" | "counter" | "decline" | "none";
  note: string;
}

export interface Need {
  id: string;
  kind: "info" | "approval";
  question: string;
  secret: boolean;
  offer?: Offer;
}
