import { context, SpanKind, trace } from "../otel/index.js";
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

  // Outbound rewrite/cancel hook. Observe-only here: we capture content + target
  // and return nothing so delivery is unaffected.
  if (cfg.captureMessageSending) {
    api.on(
      "message_sending",
      (event: unknown, ctx: unknown) => {
        try {
          const sessionKey = sessionKeyFrom(event, ctx);
          const ev = event as Record<string, unknown>;
          const c = ctx as Record<string, unknown>;
          const channel = typeof c.channelId === "string" ? c.channelId : "unknown";
          const to = typeof ev.to === "string" ? ev.to : "unknown";

          const s = sessionState.get(sessionKey);
          const parentContext = s?.agentContext ?? s?.rootContext ?? context.active();

          const attrs: Record<string, string | number | boolean> = {
            "openclaw.session.key": sessionKey,
            "openclaw.message.channel": channel,
            "openclaw.message.to": to,
            "openclaw.message.direction": "outbound",
            "openclaw.hook": "message_sending",
          };
          const content = textAttr(typeof ev.content === "string" ? ev.content : undefined);
          if (content) attrs["openclaw.message.content"] = content;
          if (typeof ev.content === "string") attrs["openclaw.message.content_length"] = ev.content.length;
          if (typeof ev.threadId === "string" || typeof ev.threadId === "number") {
            attrs["openclaw.message.thread_id"] = String(ev.threadId);
          }

          gt.startSpan(
            "openclaw.message.sending",
            { kind: SpanKind.SERVER, attributes: attrs },
            parentContext
          ).end();
        } catch {
          /* ignore */
        }
        return undefined;
      },
      { priority: 60 }
    );
  }

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
