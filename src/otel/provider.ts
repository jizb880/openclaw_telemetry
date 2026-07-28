import type { BatchSpanProcessor } from "./batch-processor.js";
import type { Context, Tracer } from "./context.js";
import { createSpan, type ReadableSpan } from "./span.js";
import type { Attributes, Span, SpanOptions } from "./primitives.js";

export type TracerProviderOptions = {
  resource: { attributes: Attributes };
  scope: { name: string; version: string };
  spanProcessors: BatchSpanProcessor[];
};

/**
 * Owns the span processors and hands out tracers, replacing
 * `NodeTracerProvider`. Deliberately not registered globally: this plugin holds
 * its provider explicitly, so it cannot conflict with a host-installed SDK.
 */
export class TracerProvider {
  private readonly processors: BatchSpanProcessor[];

  constructor(private readonly options: TracerProviderOptions) {
    this.processors = options.spanProcessors;
  }

  getTracer(): Tracer {
    const onEnd = (span: ReadableSpan): void => {
      for (const p of this.processors) p.onEnd(span);
    };
    return {
      startSpan: (name: string, options?: SpanOptions, parentContext?: Context): Span =>
        createSpan(name, options, parentContext, onEnd),
    };
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.processors.map((p) => p.flush()));
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.processors.map((p) => p.shutdown()));
  }
}
