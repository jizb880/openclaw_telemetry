import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ObservabilityConfig } from "../config/observability.js";
import { jsonAttr } from "../util/attributes.js";
import type { GlobalTracer } from "../tracer.js";
import { sessionState, toolStacks } from "./state.js";

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
 * Tool calls: `before_tool_call` opens a span; `after_tool_call` closes it (async-safe via stack).
 * `tool_result_persist` (host ≥ 2026.7) emits a short observe-only span at persistence time.
 */
export function registerToolHooks(
  api: { on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void },
  gt: GlobalTracer,
  cfg: ObservabilityConfig
): void {
  if (!cfg.captureTool) return;

  api.on(
    "before_tool_call",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const ev = event as Record<string, unknown>;
        const toolName = typeof ev.toolName === "string" ? ev.toolName : "unknown";

        const s = sessionState.get(sessionKey);
        const parentContext = s?.agentContext ?? s?.rootContext ?? context.active();

        const attrs: Record<string, string | number | boolean> = {
          "openclaw.session.key": sessionKey,
          "openclaw.tool.name": toolName,
        };

        if (cfg.captureToolInput && ev.params !== undefined) {
          attrs["openclaw.tool.input"] = jsonAttr(ev.params);
        }

        const span = gt.startSpan(
          `openclaw.tool.${toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: attrs,
          },
          parentContext
        );

        const stack = toolStacks.get(sessionKey) ?? [];
        stack.push({ span, toolName });
        toolStacks.set(sessionKey, stack);
      } catch {
        /* ignore */
      }
    },
    { priority: 50 }
  );

  api.on(
    "after_tool_call",
    (event: unknown, ctx: unknown) => {
      try {
        const sessionKey = sessionKeyFrom(event, ctx);
        const ev = event as Record<string, unknown>;
        const stack = toolStacks.get(sessionKey);
        const pending = stack?.pop();
        if (!pending) return;
        if (stack?.length === 0) toolStacks.delete(sessionKey);
        else toolStacks.set(sessionKey, stack!);

        const { span } = pending;
        const durationMs = typeof ev.durationMs === "number" ? ev.durationMs : undefined;
        if (durationMs !== undefined) {
          span.setAttribute("openclaw.tool.duration_ms", durationMs);
        }

        const err = ev.error;
        const success = !err;

        const output = ev.result ?? ev.output;
        if (cfg.captureToolOutput && success && output !== undefined) {
          span.setAttribute("openclaw.tool.output", jsonAttr(output));
          span.setAttribute("openclaw.tool.result_chars", jsonAttr(output).length);
        }
        if (!success && err) {
          span.setAttribute("openclaw.tool.error", String(err).slice(0, 2000));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: String(err).slice(0, 200),
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      } catch {
        /* ignore */
      }
    },
    { priority: -50 }
  );

  // Tool-result persistence rewrite point (host ≥ 2026.7). MUST be synchronous —
  // the host ignores (and warns on) a Promise return here. We observe only and
  // never return a rewritten message, so persistence is unaffected.
  if (cfg.captureToolResultPersist) {
    api.on(
      "tool_result_persist",
      (event: unknown, ctx: unknown) => {
        try {
          const sessionKey = sessionKeyFrom(event, ctx);
          const s = sessionState.get(sessionKey);
          const parent = s?.agentContext ?? s?.rootContext;
          const ev = event as Record<string, unknown>;

          const attrs: Record<string, string | number | boolean> = {
            "openclaw.session.key": sessionKey,
            "openclaw.hook": "tool_result_persist",
          };
          const c = ctx as Record<string, unknown>;
          const toolName =
            (typeof ev.toolName === "string" && ev.toolName) ||
            (typeof c?.toolName === "string" && c.toolName) ||
            "unknown";
          attrs["openclaw.tool.name"] = toolName;
          if (typeof ev.toolCallId === "string") attrs["openclaw.tool.call_id"] = ev.toolCallId;
          if (typeof ev.isSynthetic === "boolean") attrs["openclaw.tool.is_synthetic"] = ev.isSynthetic;

          // The tool result lives in `message.content`; there is no separate `result` field.
          const message = ev.message;
          if (cfg.captureToolOutput && message !== undefined) {
            attrs["openclaw.tool.persist_message"] = jsonAttr(message);
            const content = (message as Record<string, unknown> | null)?.content;
            if (content !== undefined) {
              const rendered = jsonAttr(content);
              attrs["openclaw.tool.persist_result"] = rendered;
              attrs["openclaw.tool.persist_result_chars"] = rendered.length;
            }
          }

          gt.startSpan(
            "openclaw.tool.result_persist",
            { kind: SpanKind.INTERNAL, attributes: attrs },
            parent
          ).end();
        } catch {
          /* ignore */
        }
        // Synchronous, no return → no rewrite.
      },
      { priority: 50 }
    );
  }
}
