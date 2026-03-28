import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ObservabilityConfig } from "../config/observability.js";
import type { GlobalTracer } from "../tracer.js";
import { enrichAgentSpanForLlm } from "./llm.js";
import { sessionState, toolStacks } from "./state.js";

function sessionKeyFrom(event: unknown, ctx: unknown): string {
  const e = event as Record<string, unknown> | undefined;
  const c = ctx as Record<string, unknown> | undefined;
  const key =
    (typeof e?.sessionKey === "string" && e.sessionKey) ||
    (typeof c?.sessionKey === "string" && c.sessionKey) ||
    "unknown";
  return key;
}

/**
 * Action / session lifecycle: inbound message → agent turn (maps to OpenClaw "action" layer).
 */
export function registerActionHooks(
  api: { on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void },
  gt: GlobalTracer,
  cfg: ObservabilityConfig
): void {
  if (!cfg.captureAction) return;

  api.on(
    "message_received",
    (_event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(_event, ctx);
        const event = _event as Record<string, unknown>;
        const channel =
          (typeof event.channel === "string" && event.channel) ||
          (typeof event.channelId === "string" && event.channelId) ||
          "unknown";
        const from =
          (typeof event.from === "string" && event.from) ||
          (typeof event.senderId === "string" && event.senderId) ||
          "unknown";

        const rootSpan = gt.startSpan(
          "openclaw.request",
          {
            kind: SpanKind.SERVER,
            attributes: {
              "openclaw.session.key": sessionKey,
              "openclaw.message.channel": channel,
              "openclaw.message.from": from,
              "openclaw.message.direction": "inbound",
            },
          },
          context.active()
        );

        const rootContext = trace.setSpan(context.active(), rootSpan);
        sessionState.set(sessionKey, {
          rootSpan,
          rootContext,
          startTime: Date.now(),
        });
      } catch {
        /* never break host */
      }
    },
    { priority: 100 }
  );

  api.on(
    "before_agent_start",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const ev = event as Record<string, unknown>;
        const c = ctx as Record<string, unknown>;
        const agentId =
          (typeof ev.agentId === "string" && ev.agentId) ||
          (typeof c.agentId === "string" && c.agentId) ||
          "unknown";
        const model =
          (typeof ev.model === "string" && ev.model) ||
          (typeof ev.modelId === "string" && ev.modelId) ||
          "unknown";

        let s = sessionState.get(sessionKey);
        const parentContext = s?.rootContext ?? context.active();

        const agentSpan = gt.startSpan(
          "openclaw.action",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
              "openclaw.agent.model": model,
            },
          },
          parentContext
        );

        const agentContext = trace.setSpan(parentContext, agentSpan);

        if (s) {
          s.agentSpan = agentSpan;
          s.agentContext = agentContext;
        } else {
          s = {
            rootSpan: agentSpan,
            rootContext: agentContext,
            agentSpan,
            agentContext,
            startTime: Date.now(),
          };
          sessionState.set(sessionKey, s);
        }
      } catch {
        /* ignore */
      }
      return undefined;
    },
    { priority: 90 }
  );

  api.on(
    "agent_end",
    async (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const s = sessionState.get(sessionKey);
        if (!s) return;

        const orphans = toolStacks.get(sessionKey);
        if (orphans?.length) {
          for (const p of orphans) {
            try {
              p.span.setStatus({ code: SpanStatusCode.ERROR, message: "missing after_tool_call" });
              p.span.end();
            } catch {
              /* ignore */
            }
          }
          toolStacks.delete(sessionKey);
        }

        const ev = event as Record<string, unknown>;
        const success = ev.success !== false;
        const durationMs = typeof ev.durationMs === "number" ? ev.durationMs : undefined;
        const err = ev.error;

        if (s.agentSpan) {
          enrichAgentSpanForLlm(s.agentSpan, ev, cfg);
          if (durationMs !== undefined) {
            s.agentSpan.setAttribute("openclaw.agent.duration_ms", durationMs);
          }
          s.agentSpan.setAttribute("openclaw.agent.success", success);
          if (err) {
            s.agentSpan.setAttribute("openclaw.agent.error", String(err).slice(0, 500));
            s.agentSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(err).slice(0, 200),
            });
          } else {
            s.agentSpan.setStatus({ code: SpanStatusCode.OK });
          }
          s.agentSpan.end();
        }

        if (s.rootSpan && s.rootSpan !== s.agentSpan) {
          s.rootSpan.setAttribute("openclaw.request.duration_ms", Date.now() - s.startTime);
          s.rootSpan.setStatus({ code: SpanStatusCode.OK });
          s.rootSpan.end();
        }

        sessionState.delete(sessionKey);
      } catch {
        /* ignore */
      }
    },
    { priority: -100 }
  );
}
