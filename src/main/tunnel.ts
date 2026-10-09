import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

let proc: ChildProcess | null = null;

const CANDIDATES = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];

export function cloudflaredPath(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export function startTunnel(port: number, timeoutMs = 20000): Promise<string> {
  const bin = cloudflaredPath();
  if (!bin) return Promise.reject(new Error("cloudflared isn't installed. Run: brew install cloudflared, or paste an ngrok https URL instead."));
  stopTunnel();
  return new Promise((resolve, reject) => {
    proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => reject(new Error("Tunnel didn't start in time")), timeoutMs);
    const scan = (b: Buffer) => {
      const m = b.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    proc.stdout?.on("data", scan);
    proc.stderr?.on("data", scan);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited (${code})`));
    });
  });
}

export function stopTunnel() {
  proc?.kill();
  proc = null;
}
