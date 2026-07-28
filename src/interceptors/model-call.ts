import { SpanKind, SpanStatusCode } from "../otel/index.js";
import type { ObservabilityConfig } from "../config/observability.js";
import type { GlobalTracer } from "../tracer.js";
import { modelCallKey, modelCallSpans, sessionState } from "./state.js";

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
 * Provider-call telemetry (`model_call_started` / `model_call_ended`).
 *
 * Sanitized by design: the host never puts prompts, responses, headers, request
 * bodies, or raw provider request-ids on these events. We capture timing, TTFB,
 * streamed byte counts, outcome, and a bounded upstream request-id hash.
 */
export function registerModelCallHooks(
  api: { on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void },
  gt: GlobalTracer,
  cfg: ObservabilityConfig
): void {
  if (!cfg.captureModelCall) return;

  api.on(
    "model_call_started",
    (event: unknown, ctx: unknown) => {
      try {
        const ev = event as Record<string, unknown>;
        const runId = typeof ev.runId === "string" ? ev.runId : "unknown";
        const callId = typeof ev.callId === "string" ? ev.callId : "unknown";
        const sessionKey = sessionKeyFrom(event, ctx);

        const s = sessionState.get(sessionKey);
        const parent = s?.agentContext ?? s?.rootContext;

        const attrs: Record<string, string | number | boolean> = {
          "openclaw.session.key": sessionKey,
          "openclaw.hook": "model_call_started",
          "openclaw.run.id": runId,
          "openclaw.model_call.id": callId,
        };
        if (typeof ev.provider === "string") attrs["gen_ai.system"] = ev.provider;
        if (typeof ev.model === "string") attrs["gen_ai.request.model"] = ev.model;
        if (typeof ev.api === "string") attrs["openclaw.model_call.api"] = ev.api;
        if (typeof ev.transport === "string") attrs["openclaw.model_call.transport"] = ev.transport;
        if (typeof ev.contextTokenBudget === "number") {
          attrs["openclaw.model_call.context_token_budget"] = ev.contextTokenBudget;
        }

        const span = gt.startSpan(
          "openclaw.model_call",
          { kind: SpanKind.CLIENT, attributes: attrs },
          parent
        );
        modelCallSpans.set(modelCallKey(runId, callId), { span, callId });
      } catch {
        /* ignore */
      }
      return undefined;
    },
    { priority: 60 }
  );

  api.on(
    "model_call_ended",
    (event: unknown, _ctx: unknown) => {
      try {
        const ev = event as Record<string, unknown>;
        const runId = typeof ev.runId === "string" ? ev.runId : "unknown";
        const callId = typeof ev.callId === "string" ? ev.callId : "unknown";
        const key = modelCallKey(runId, callId);
        const pending = modelCallSpans.get(key);
        if (!pending) return undefined;
        modelCallSpans.delete(key);

        const { span } = pending;
        if (typeof ev.durationMs === "number") span.setAttribute("openclaw.model_call.duration_ms", ev.durationMs);
        if (typeof ev.timeToFirstByteMs === "number") {
          span.setAttribute("openclaw.model_call.ttfb_ms", ev.timeToFirstByteMs);
        }
        if (typeof ev.responseStreamBytes === "number") {
          span.setAttribute("openclaw.model_call.response_stream_bytes", ev.responseStreamBytes);
        }
        if (typeof ev.requestPayloadBytes === "number") {
          span.setAttribute("openclaw.model_call.request_payload_bytes", ev.requestPayloadBytes);
        }
        if (typeof ev.upstreamRequestIdHash === "string") {
          span.setAttribute("openclaw.model_call.upstream_request_id_hash", ev.upstreamRequestIdHash);
        }
        const outcome = typeof ev.outcome === "string" ? ev.outcome : "completed";
        span.setAttribute("openclaw.model_call.outcome", outcome);
        if (typeof ev.errorCategory === "string") {
          span.setAttribute("openclaw.model_call.error_category", ev.errorCategory);
        }
        if (typeof ev.failureKind === "string") {
          span.setAttribute("openclaw.model_call.failure_kind", ev.failureKind);
        }

        if (outcome === "error") {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(ev.errorCategory ?? "error") });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
      } catch {
        /* ignore */
      }
      return undefined;
    },
    { priority: -60 }
  );
}
