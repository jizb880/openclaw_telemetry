import { AsyncLocalStorage } from "node:async_hooks";
import type { Span, SpanContext, SpanOptions } from "./primitives.js";

/**
 * Minimal context propagation, replacing `@opentelemetry/api`'s context manager.
 *
 * A `Context` is an immutable key/value map. The only key this plugin needs is
 * the active span, but the map shape is kept general so callers can attach more
 * without changing this file.
 */
export type ContextKey = symbol;

export interface Context {
  getValue(key: ContextKey): unknown;
  setValue(key: ContextKey, value: unknown): Context;
  deleteValue(key: ContextKey): Context;
}

class ContextImpl implements Context {
  constructor(private readonly entries: Map<ContextKey, unknown> = new Map()) {}

  getValue(key: ContextKey): unknown {
    return this.entries.get(key);
  }

  setValue(key: ContextKey, value: unknown): Context {
    const next = new Map(this.entries);
    next.set(key, value);
    return new ContextImpl(next);
  }

  deleteValue(key: ContextKey): Context {
    const next = new Map(this.entries);
    next.delete(key);
    return new ContextImpl(next);
  }
}

/** The empty root context. */
export const ROOT_CONTEXT: Context = new ContextImpl();

/**
 * Creates spans. Defined here rather than in `./primitives.ts` because it
 * references `Context`, which this module owns.
 */
export interface Tracer {
  startSpan(name: string, options?: SpanOptions, parentContext?: Context): Span;
}

const SPAN_KEY: ContextKey = Symbol.for("opentelemetry.trace.span_key");

const storage = new AsyncLocalStorage<Context>();

/** Context manager API, shaped like `@opentelemetry/api`'s `context`. */
export const context = {
  /** The context bound to the current async execution, or ROOT_CONTEXT. */
  active(): Context {
    return storage.getStore() ?? ROOT_CONTEXT;
  },

  /** Run `fn` with `ctx` as the active context (sync or async). */
  with<T>(ctx: Context, fn: () => T): T {
    return storage.run(ctx, fn);
  },
};

/** Trace helpers, shaped like `@opentelemetry/api`'s `trace`. */
export const trace = {
  /** Return a new context with `span` set as active. */
  setSpan(ctx: Context, span: Span): Context {
    return ctx.setValue(SPAN_KEY, span);
  },

  /** The active span in `ctx` (defaults to the current context), if any. */
  getSpan(ctx: Context = context.active()): Span | undefined {
    return ctx.getValue(SPAN_KEY) as Span | undefined;
  },

  /** The span context of the active span in `ctx`, if any. */
  getSpanContext(ctx: Context = context.active()): SpanContext | undefined {
    return trace.getSpan(ctx)?.spanContext();
  },

  /** Remove any active span from `ctx`. */
  deleteSpan(ctx: Context): Context {
    return ctx.deleteValue(SPAN_KEY);
  },
};
