import { SpanKind, type Span } from "../otel/index.js";
import type { ObservabilityConfig } from "../config/observability.js";
import type { GlobalTracer } from "../tracer.js";
import { textAttr } from "../util/attributes.js";
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

function historyCountOf(ev: Record<string, unknown>): number | undefined {
  const messages = ev.messages;
  return Array.isArray(messages) ? messages.length : undefined;
}

/**
 * Input-gate capture (`before_agent_run`, with legacy `before_agent_start` fallback).
 *
 * Modern hosts emit both `before_agent_start` (legacy combined phase) and
 * `before_agent_run` (the real gate); older hosts emit only
 * `before_agent_start`. To capture on both without double-counting:
 *
 *  - `before_agent_start` opens the `openclaw.agent.run` span with best-effort
 *    data (`content` = prompt, `history_count` = messages.length) so timing is right.
 *  - `before_agent_run` enriches the same span with `systemPrompt` and the
 *    authoritative history count, then closes it.
 *  - `agent_end` closes any span still open (old hosts with no `before_agent_run`).
 *
 * Unknown hook names are silently ignored by the host registry, so registering
 * `before_agent_run` on an old host is a harmless no-op.
 */
export function registerAgentRunHooks(
  api: { on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void },
  gt: GlobalTracer,
  cfg: ObservabilityConfig
): void {
  if (!cfg.captureAgentRun) return;

  const openGateSpan = (
    sessionKey: string,
    attrs: Record<string, string | number | boolean>
  ): Span => {
    const s = sessionState.get(sessionKey);
    const parent = s?.agentContext ?? s?.rootContext;
    return gt.startSpan("openclaw.agent.run", { kind: SpanKind.INTERNAL, attributes: attrs }, parent);
  };

  // Legacy / early phase: create the gate span with best-effort data.
  api.on(
    "before_agent_start",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const s = sessionState.get(sessionKey);
        if (!s || s.gateSpan) return undefined;

        const ev = event as Record<string, unknown>;
        const attrs: Record<string, string | number | boolean> = {
          "openclaw.session.key": sessionKey,
          "openclaw.hook": "before_agent_start",
          "openclaw.agent_run.source": "before_agent_start",
        };
        const content = textAttr(typeof ev.prompt === "string" ? ev.prompt : undefined);
        if (content) attrs["openclaw.agent_run.content"] = content;
        const hc = historyCountOf(ev);
        if (hc !== undefined) attrs["openclaw.agent_run.history_count"] = hc;

        s.gateSpan = openGateSpan(sessionKey, attrs);
      } catch {
        /* ignore */
      }
      return undefined;
    },
    { priority: 80 }
  );

  const enrich = (span: Span, ev: Record<string, unknown>): void => {
    span.setAttribute("openclaw.hook", "before_agent_run");
    span.setAttribute("openclaw.agent_run.source", "before_agent_run");
    const content = textAttr(typeof ev.prompt === "string" ? ev.prompt : undefined);
    if (content) span.setAttribute("openclaw.agent_run.content", content);
    const sys = textAttr(typeof ev.systemPrompt === "string" ? ev.systemPrompt : undefined);
    if (sys) span.setAttribute("openclaw.agent_run.system_prompt", sys);
    const hc = historyCountOf(ev);
    if (hc !== undefined) span.setAttribute("openclaw.agent_run.history_count", hc);
    if (typeof ev.channelId === "string") span.setAttribute("openclaw.agent_run.channel_id", ev.channelId);
    if (typeof ev.senderId === "string") span.setAttribute("openclaw.agent_run.sender_id", ev.senderId);
    if (typeof ev.senderIsOwner === "boolean") {
      span.setAttribute("openclaw.agent_run.sender_is_owner", ev.senderIsOwner);
    }
  };

  // Authoritative gate: full prompt + system prompt + history count.
  api.on(
    "before_agent_run",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const s = sessionState.get(sessionKey);
        const ev = event as Record<string, unknown>;

        if (s?.gateSpan) {
          enrich(s.gateSpan, ev);
          s.gateSpan.end();
          s.gateSpan = undefined;
          return undefined;
        }

        // No pre-created span (defensive): emit a standalone one.
        const span = openGateSpan(sessionKey, { "openclaw.session.key": sessionKey });
        enrich(span, ev);
        span.end();
      } catch {
        /* ignore */
      }
      return undefined;
    },
    { priority: 80 }
  );

  // Fallback close for hosts without `before_agent_run`.
  api.on(
    "agent_end",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const s = sessionState.get(sessionKey);
        if (s?.gateSpan) {
          s.gateSpan.end();
          s.gateSpan = undefined;
        }
      } catch {
        /* ignore */
      }
      return undefined;
    },
    { priority: -90 }
  );
}
