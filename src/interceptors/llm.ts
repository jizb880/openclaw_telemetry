import { SpanKind, type Span } from "../otel/index.js";
import type { ObservabilityConfig } from "../config/observability.js";
import type { GlobalTracer } from "../tracer.js";
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

function historyCountOf(ev: Record<string, unknown>): number | undefined {
  const h = ev.historyMessages;
  if (Array.isArray(h)) return h.length;
  const m = ev.messages;
  return Array.isArray(m) ? m.length : undefined;
}

/**
 * LLM interaction capture.
 *
 * - `before_agent_start`: legacy prompt capture onto the agent span (`gen_ai.prompt`).
 * - `llm_input` (observe-only): provider input — system prompt, prompt, history count.
 * - `llm_output`: provider output — the host-aggregated assistant text and token usage.
 *
 * `llm_input` / `llm_output` are conversation hooks: a non-bundled plugin must set
 * `plugins.entries.<id>.hooks.allowConversationAccess = true` or the host blocks them.
 */
export function registerLlmHooks(
  api: { on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void },
  gt: GlobalTracer,
  cfg: ObservabilityConfig
): void {
  if (!cfg.captureLlm) return;

  if (cfg.captureLlmInput) {
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

    // Provider input, observe-only. Fires with full system prompt + prompt + history.
    api.on(
      "llm_input",
      (event: unknown, ctx: unknown) => {
        try {
          const sessionKey = sessionKeyFrom(event, ctx);
          const s = sessionState.get(sessionKey);
          const parent = s?.agentContext ?? s?.rootContext;
          const ev = event as Record<string, unknown>;

          const attrs: Record<string, string | number | boolean> = {
            "openclaw.session.key": sessionKey,
            "openclaw.hook": "llm_input",
            "openclaw.llm.observe_only": true,
          };
          if (typeof ev.provider === "string") attrs["gen_ai.system"] = ev.provider;
          if (typeof ev.model === "string") attrs["gen_ai.request.model"] = ev.model;
          if (typeof ev.runId === "string") attrs["openclaw.run.id"] = ev.runId;
          if (typeof ev.imagesCount === "number") attrs["openclaw.llm.images_count"] = ev.imagesCount;

          const content = textAttr(typeof ev.prompt === "string" ? ev.prompt : undefined);
          if (content) attrs["openclaw.llm.content"] = content;
          const sys = textAttr(typeof ev.systemPrompt === "string" ? ev.systemPrompt : undefined);
          if (sys) attrs["openclaw.llm.system_prompt"] = sys;
          const hc = historyCountOf(ev);
          if (hc !== undefined) attrs["openclaw.llm.history_count"] = hc;

          gt.startSpan("openclaw.llm.input", { kind: SpanKind.INTERNAL, attributes: attrs }, parent).end();
        } catch {
          /* ignore */
        }
        return undefined;
      },
      { priority: 60 }
    );
  }

  if (cfg.captureLlmOutput) {
    // Provider output: host has already aggregated streamed chunks into text.
    api.on(
      "llm_output",
      (event: unknown, ctx: unknown) => {
        try {
          const sessionKey = sessionKeyFrom(event, ctx);
          const s = sessionState.get(sessionKey);
          const parent = s?.agentContext ?? s?.rootContext;
          const ev = event as Record<string, unknown>;

          const attrs: Record<string, string | number | boolean> = {
            "openclaw.session.key": sessionKey,
            "openclaw.hook": "llm_output",
          };
          if (typeof ev.provider === "string") attrs["gen_ai.system"] = ev.provider;
          if (typeof ev.model === "string") attrs["gen_ai.response.model"] = ev.model;
          if (typeof ev.runId === "string") attrs["openclaw.run.id"] = ev.runId;

          // `assistantTexts` is the host-aggregated full response (joined).
          const texts = Array.isArray(ev.assistantTexts) ? ev.assistantTexts : [];
          const joined = texts.filter((t) => typeof t === "string").join("");
          const content = textAttr(joined);
          if (content) attrs["openclaw.llm.content"] = content;

          const usage = ev.usage;
          if (usage && typeof usage === "object") {
            const u = usage as Record<string, unknown>;
            if (typeof u.input === "number") attrs["gen_ai.usage.input_tokens"] = u.input;
            if (typeof u.output === "number") attrs["gen_ai.usage.output_tokens"] = u.output;
            if (typeof u.total === "number") attrs["openclaw.llm.usage.total_tokens"] = u.total;
            if (typeof u.cacheRead === "number") attrs["openclaw.llm.usage.cache_read"] = u.cacheRead;
            if (typeof u.cacheWrite === "number") attrs["openclaw.llm.usage.cache_write"] = u.cacheWrite;
          }

          gt.startSpan("openclaw.llm.output", { kind: SpanKind.INTERNAL, attributes: attrs }, parent).end();
        } catch {
          /* ignore */
        }
        return undefined;
      },
      { priority: 60 }
    );
  }
}
