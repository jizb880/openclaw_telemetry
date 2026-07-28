import { SpanKind } from "../otel/index.js";
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
 * Context-compaction cycles.
 *
 * Current hosts use `before_compaction` / `after_compaction`. Older hosts used
 * `before_context_prune` / `after_context_prune`. We register both name pairs;
 * the host registry silently ignores hook names it does not recognize, and the
 * old and new names never coexist on one host, so there is no double-counting.
 */
export function registerCompactionHooks(
  api: { on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void },
  gt: GlobalTracer,
  cfg: ObservabilityConfig
): void {
  if (!cfg.captureCompaction) return;

  const onBefore = (hookName: string) => (event: unknown, ctx: unknown) => {
    try {
      const sessionKey = sessionKeyFrom(event, ctx);
      const s = sessionState.get(sessionKey);
      const parent = s?.agentContext ?? s?.rootContext;
      const ev = event as Record<string, unknown>;

      const attrs: Record<string, string | number | boolean> = {
        "openclaw.session.key": sessionKey,
        "openclaw.hook": hookName,
        "openclaw.compaction.phase": "before",
      };
      if (typeof ev.messageCount === "number") attrs["openclaw.compaction.message_count"] = ev.messageCount;
      if (typeof ev.compactingCount === "number") {
        attrs["openclaw.compaction.compacting_count"] = ev.compactingCount;
      }
      if (typeof ev.tokenCount === "number") attrs["openclaw.compaction.token_count"] = ev.tokenCount;

      gt.startSpan("openclaw.compaction.before", { kind: SpanKind.INTERNAL, attributes: attrs }, parent).end();
    } catch {
      /* ignore */
    }
    return undefined;
  };

  const onAfter = (hookName: string) => (event: unknown, ctx: unknown) => {
    try {
      const sessionKey = sessionKeyFrom(event, ctx);
      const s = sessionState.get(sessionKey);
      const parent = s?.agentContext ?? s?.rootContext;
      const ev = event as Record<string, unknown>;

      const attrs: Record<string, string | number | boolean> = {
        "openclaw.session.key": sessionKey,
        "openclaw.hook": hookName,
        "openclaw.compaction.phase": "after",
      };
      if (typeof ev.messageCount === "number") attrs["openclaw.compaction.message_count"] = ev.messageCount;
      if (typeof ev.compactedCount === "number") attrs["openclaw.compaction.compacted_count"] = ev.compactedCount;
      if (typeof ev.tokenCount === "number") attrs["openclaw.compaction.token_count"] = ev.tokenCount;
      if (typeof ev.previousSessionId === "string") {
        attrs["openclaw.compaction.previous_session_id"] = ev.previousSessionId;
      }

      gt.startSpan("openclaw.compaction.after", { kind: SpanKind.INTERNAL, attributes: attrs }, parent).end();
    } catch {
      /* ignore */
    }
    return undefined;
  };

  // Current names.
  api.on("before_compaction", onBefore("before_compaction"), { priority: 60 });
  api.on("after_compaction", onAfter("after_compaction"), { priority: -60 });

  // Legacy aliases (ignored by hosts that don't know them).
  api.on("before_context_prune", onBefore("before_context_prune"), { priority: 60 });
  api.on("after_context_prune", onAfter("after_context_prune"), { priority: -60 });
}
