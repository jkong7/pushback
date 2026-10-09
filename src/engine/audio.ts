const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulaw(sample: number): number {
  let s = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const s = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -s : s;
}

const DTMF: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};

export function dtmfTones(digits: string, rate = 8000, toneMs = 120, gapMs = 100): Buffer {
  const parts: number[] = [];
  const silence = (ms: number) => {
    for (let i = 0; i < (rate * ms) / 1000; i++) parts.push(linearToMulaw(0));
  };
  silence(150);
  for (const d of digits) {
    if (d === "w") {
      silence(500);
      continue;
    }
    const f = DTMF[d];
    if (!f) continue;
    const n = (rate * toneMs) / 1000;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      parts.push(linearToMulaw(7000 * (Math.sin(2 * Math.PI * f[0] * t) + Math.sin(2 * Math.PI * f[1] * t))));
    }
    silence(gapMs);
  }
  return Buffer.from(parts);
}

export function detectDtmf(mulaw: Buffer, rate = 8000): string | null {
  const samples = Array.from(mulaw, mulawToLinear);
  const power = (freq: number) => {
    const k = (2 * Math.cos((2 * Math.PI * freq) / rate));
    let s1 = 0, s2 = 0;
    for (const x of samples) {
      const s0 = x + k * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - k * s1 * s2;
  };
  const rows = [697, 770, 852, 941].map(power);
  const cols = [1209, 1336, 1477].map(power);
  const r = rows.indexOf(Math.max(...rows));
  const c = cols.indexOf(Math.max(...cols));
  if (rows[r] < 1e9 || cols[c] < 1e9) return null;
  return [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["*", "0", "#"]][r][c];
}

export function rms(mulaw: Buffer): number {
  if (!mulaw.length) return 0;
  let sum = 0;
  for (const b of mulaw) {
    const v = mulawToLinear(b);
    sum += v * v;
  }
  return Math.sqrt(sum / mulaw.length);
}

export class EnergyGate {
  private loudMs = 0;
  private lastWords = Date.now();
  private threshold: number;
  constructor(threshold = 600) {
    this.threshold = threshold;
  }

  frame(mulaw: Buffer, now = Date.now()): "music" | null {
    const ms = (mulaw.length / 8000) * 1000;
    if (rms(mulaw) > this.threshold) this.loudMs += ms;
    else this.loudMs = Math.max(0, this.loudMs - ms / 2);
    if (this.loudMs > 6000 && now - this.lastWords > 6000) {
      this.loudMs = 0;
      return "music";
    }
    return null;
  }

  words(now = Date.now()) {
    this.lastWords = now;
  }
}
