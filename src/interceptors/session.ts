import { SpanKind } from "../otel/index.js";
import type { ObservabilityConfig } from "../config/observability.js";
import type { GlobalTracer } from "../tracer.js";

function sessionKeyFrom(event: unknown, ctx: unknown): string {
  const e = event as Record<string, unknown> | undefined;
  const c = ctx as Record<string, unknown> | undefined;
  return (
    (typeof e?.sessionKey === "string" && e.sessionKey) ||
    (typeof c?.sessionKey === "string" && c.sessionKey) ||
    "unknown"
  );
}

function sessionIdFrom(event: unknown, ctx: unknown): string | undefined {
  const e = event as Record<string, unknown> | undefined;
  const c = ctx as Record<string, unknown> | undefined;
  return (
    (typeof e?.sessionId === "string" && e.sessionId) ||
    (typeof c?.sessionId === "string" && c.sessionId) ||
    undefined
  );
}

/**
 * Session lifecycle boundaries (`session_start` / `session_end`).
 *
 * These fire outside any agent turn, so the spans are standalone (no parent).
 * `session_end.reason` is one of new/reset/idle/daily/compaction/deleted/
 * shutdown/restart/unknown.
 */
export function registerSessionHooks(
  api: { on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void },
  gt: GlobalTracer,
  cfg: ObservabilityConfig
): void {
  if (!cfg.captureSession) return;

  api.on(
    "session_start",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const ev = event as Record<string, unknown>;
        const attrs: Record<string, string | number | boolean> = {
          "openclaw.session.key": sessionKey,
          "openclaw.hook": "session_start",
        };
        const sid = sessionIdFrom(event, ctx);
        if (sid) attrs["openclaw.session.id"] = sid;
        if (typeof ev.resumedFrom === "string") attrs["openclaw.session.resumed_from"] = ev.resumedFrom;

        gt.startSpan("openclaw.session.start", { kind: SpanKind.INTERNAL, attributes: attrs }).end();
      } catch {
        /* ignore */
      }
      return undefined;
    },
    { priority: 100 }
  );

  api.on(
    "session_end",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const ev = event as Record<string, unknown>;
        const attrs: Record<string, string | number | boolean> = {
          "openclaw.session.key": sessionKey,
          "openclaw.hook": "session_end",
        };
        const sid = sessionIdFrom(event, ctx);
        if (sid) attrs["openclaw.session.id"] = sid;
        if (typeof ev.reason === "string") attrs["openclaw.session.reason"] = ev.reason;
        if (typeof ev.messageCount === "number") attrs["openclaw.session.message_count"] = ev.messageCount;
        if (typeof ev.durationMs === "number") attrs["openclaw.session.duration_ms"] = ev.durationMs;
        if (typeof ev.transcriptArchived === "boolean") {
          attrs["openclaw.session.transcript_archived"] = ev.transcriptArchived;
        }
        if (typeof ev.nextSessionId === "string") attrs["openclaw.session.next_session_id"] = ev.nextSessionId;

        gt.startSpan("openclaw.session.end", { kind: SpanKind.INTERNAL, attributes: attrs }).end();
      } catch {
        /* ignore */
      }
      return undefined;
    },
    { priority: -100 }
  );
}
