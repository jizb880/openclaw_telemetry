import { context, SpanKind, trace } from "@opentelemetry/api";
import type { ObservabilityConfig } from "../config/observability.js";
import type { GlobalTracer } from "../tracer.js";
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
 * Inbound / outbound message hooks (aligned with knostic/openclaw-telemetry).
 */
export function registerMessageHooks(
  api: { on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void },
  gt: GlobalTracer,
  cfg: ObservabilityConfig
): void {
  if (!cfg.captureMessages) return;

  api.on(
    "message_received",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const ev = event as Record<string, unknown>;
        const c = ctx as Record<string, unknown>;
        const channel =
          (typeof ev.channel === "string" && ev.channel) ||
          (typeof c.channelId === "string" && c.channelId) ||
          (typeof ev.channelId === "string" && ev.channelId) ||
          "unknown";
        const from =
          (typeof ev.from === "string" && ev.from) ||
          (typeof ev.senderId === "string" && ev.senderId) ||
          "unknown";

        const content = ev.content;
        const contentLength =
          typeof content === "string"
            ? content.length
            : content != null && typeof content === "object" && "length" in (content as object)
              ? Number((content as { length?: unknown }).length)
              : undefined;

        const attrs: Record<string, string | number | boolean> = {
          "openclaw.session.key": sessionKey,
          "openclaw.message.channel": channel,
          "openclaw.message.from": from,
          "openclaw.message.direction": "inbound",
          "openclaw.hook": "message_received",
        };

        if (typeof contentLength === "number" && !Number.isNaN(contentLength)) {
          attrs["openclaw.message.content_length"] = contentLength;
        }

        const rootSpan = gt.startSpan(
          "openclaw.request",
          {
            kind: SpanKind.SERVER,
            attributes: attrs,
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
        /* ignore */
      }
    },
    { priority: 100 }
  );

  api.on(
    "message_sent",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const ev = event as Record<string, unknown>;
        const c = ctx as Record<string, unknown>;
        const channel =
          (typeof c.channelId === "string" && c.channelId) ||
          (typeof ev.channel === "string" && ev.channel) ||
          "unknown";
        const to = typeof ev.to === "string" ? ev.to : "unknown";
        const success = ev.success !== false;
        const err = ev.error;

        const s = sessionState.get(sessionKey);
        const parentContext = s?.agentContext ?? s?.rootContext ?? context.active();

        const span = gt.startSpan(
          "openclaw.message.out",
          {
            kind: SpanKind.SERVER,
            attributes: {
              "openclaw.session.key": sessionKey,
              "openclaw.message.channel": channel,
              "openclaw.message.to": to,
              "openclaw.message.success": success,
              "openclaw.hook": "message_sent",
              ...(err ? { "openclaw.message.error": String(err).slice(0, 2000) } : {}),
            },
          },
          parentContext
        );
        span.end();
      } catch {
        /* ignore */
      }
    },
    { priority: 50 }
  );
}
