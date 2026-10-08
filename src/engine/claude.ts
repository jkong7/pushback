import Anthropic from "@anthropic-ai/sdk";
import type { Brain, BrainRequest, Effort } from "./types.ts";
import { redact } from "./vault.ts";

const DEFAULT_EFFORT: Record<BrainRequest["task"], Effort> = {
  turn: "low",
  ivr: "low",
  rep: "low",
  plan: "medium",
  outcome: "medium",
  letter: "medium",
  bill: "medium",
};

export class RefusalError extends Error {}

export class ClaudeBrain implements Brain {
  readonly name = "claude";
  private client: Anthropic;
  private model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model || "claude-opus-5-5";
  }

  private params(req: BrainRequest) {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (req.image?.mediaType === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: req.image.data } });
    else if (req.image) content.push({ type: "image", source: { type: "base64", media_type: req.image.mediaType, data: req.image.data } });
    content.push({ type: "text", text: redact(req.prompt) });
    return {
      model: this.model,
      max_tokens: req.maxTokens ?? 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default" as const,
      thinking: { type: "adaptive" as const },
      output_config: { effort: req.effort ?? DEFAULT_EFFORT[req.task] },
      system: [
        { type: "text" as const, text: req.system },
        { type: "text" as const, text: redact(req.context) || "(none)", cache_control: { type: "ephemeral" as const } },
      ],
      messages: [{ role: "user" as const, content }],
    };
  }

  async stream(req: BrainRequest, onText: (text: string) => void, signal?: AbortSignal): Promise<string> {
    const stream = this.client.beta.messages.stream(this.params(req), { signal });
    stream.on("text", onText);
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new RefusalError("Claude declined this request.");
    return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  }

  async json<T>(req: BrainRequest, schema: Record<string, unknown>): Promise<T> {
    const base = this.params(req);
    const stream = this.client.beta.messages.stream({ ...base, output_config: { ...base.output_config, format: { type: "json_schema", schema } } });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new RefusalError("Claude declined this request.");
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return JSON.parse(text) as T;
  }
}
