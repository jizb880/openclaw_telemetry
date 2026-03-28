import type { Span } from "@opentelemetry/api";
import type { ObservabilityConfig } from "../config/observability.js";
import { jsonAttr, textAttr } from "../util/attributes.js";
import { sessionState } from "./state.js";

function sessionKeyFrom(event: unknown, ctx: unknown): string {
  const e = event as Record<string, unknown> | undefined;
  const c = ctx as Record<string, unknown> | undefined;
  return (
    (typeof e?.sessionKey === "string" && e.sessionKey) ||
    (typeof c?.sessionKey === "string" && c.sessionKey) ||
    "unknown"
  );
}

/**
 * Add GenAI-style attributes from `agent_end` messages before the agent span is closed.
 */
export function enrichAgentSpanForLlm(
  agentSpan: Span,
  event: Record<string, unknown>,
  cfg: ObservabilityConfig
): void {
  if (!cfg.captureLlm) return;

  const messages = Array.isArray(event.messages) ? event.messages : [];

  let totalInput = 0;
  let totalOutput = 0;
  let model = "unknown";

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") continue;
    if (typeof m.model === "string") model = m.model;
    const u = m.usage;
    if (u && typeof u === "object") {
      const usage = u as Record<string, unknown>;
      if (typeof usage.input === "number") totalInput += usage.input;
      else if (typeof usage.inputTokens === "number") totalInput += usage.inputTokens;
      else if (typeof usage.input_tokens === "number") totalInput += usage.input_tokens;

      if (typeof usage.output === "number") totalOutput += usage.output;
      else if (typeof usage.outputTokens === "number") totalOutput += usage.outputTokens;
      else if (typeof usage.output_tokens === "number") totalOutput += usage.output_tokens;
    }
  }

  agentSpan.setAttribute("gen_ai.usage.input_tokens", totalInput);
  agentSpan.setAttribute("gen_ai.usage.output_tokens", totalOutput);
  agentSpan.setAttribute("gen_ai.response.model", model);

  if (cfg.captureLlmOutput && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last && typeof last === "object") {
      const la = last as Record<string, unknown>;
      if (la.role === "assistant" && la.content !== undefined) {
        agentSpan.setAttribute("gen_ai.completion", jsonAttr(la.content));
      }
    }
  }
}

/**
 * LLM prompt capture on `before_agent_start` (runs after Action hook creates the agent span).
 */
export function registerLlmHooks(
  api: { on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void },
  _gt: unknown,
  cfg: ObservabilityConfig
): void {
  if (!cfg.captureLlm || !cfg.captureLlmInput) return;

  api.on(
    "before_agent_start",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const s = sessionState.get(sessionKey);
        if (!s?.agentSpan) return;

        const ev = event as Record<string, unknown>;
        const prompt =
          (typeof ev.prompt === "string" && ev.prompt) ||
          (typeof ev.promptText === "string" && ev.promptText) ||
          (typeof ev.text === "string" && ev.text) ||
          "";

        if (prompt) {
          const t = textAttr(prompt);
          if (t) s.agentSpan.setAttribute("gen_ai.prompt", t);
        }
      } catch {
        /* ignore */
      }
      return undefined;
    },
    { priority: 85 }
  );
}
