import { EventEmitter } from "node:events";

export interface LineEvents {
  heard: [{ text: string; final: boolean }];
  music: [];
  speaking: [boolean];
  connected: [];
  ended: [string];
  error: [string];
}

export interface Line extends EventEmitter<LineEvents> {
  readonly kind: "sim" | "twilio";
  dial(): Promise<void>;
  say(text: string): Promise<void>;
  press(digits: string, opts?: { outOfBand?: boolean }): Promise<void>;
  interrupt(): void;
  hangup(): Promise<void>;
  handoff?(phone: string): Promise<void>;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

export const speechMs = (text: string) => Math.max(600, (text.split(/\s+/).length / 2.7) * 1000);
