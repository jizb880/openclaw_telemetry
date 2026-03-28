import { context, trace, type Context, type Span, type SpanOptions, type Tracer } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { ObservabilityConfig } from "./config/observability.js";

const INSTRUMENTATION_NAME = "openclaw-otel-observability";
const INSTRUMENTATION_VERSION = "0.1.0";

/**
 * Global singleton around `trace.getTracer()` and the Node SDK lifecycle.
 * Spans use the active async context for automatic propagation.
 */
export class GlobalTracer {
  private static instance: GlobalTracer | undefined;

  private sdk: NodeSDK | null = null;
  private apiTracer: Tracer | null = null;

  private constructor() {}

  static getInstance(): GlobalTracer {
    if (!GlobalTracer.instance) GlobalTracer.instance = new GlobalTracer();
    return GlobalTracer.instance;
  }

  init(config: ObservabilityConfig): void {
    if (!config.enabled) return;
    if (this.sdk) return;

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
    });

    const traceExporter = new OTLPTraceExporter({
      url: config.otlpEndpoint,
    });

    this.sdk = new NodeSDK({
      resource,
      traceExporter,
    });

    this.sdk.start();
    this.apiTracer = trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
  }

  isInitialized(): boolean {
    return this.apiTracer !== null;
  }

  getTracer(): Tracer {
    if (!this.apiTracer) {
      throw new Error("GlobalTracer not initialized; call init() with enabled config first.");
    }
    return this.apiTracer;
  }

  /**
   * Start a span; defaults to `context.active()` so async work keeps the same trace.
   */
  startSpan(name: string, options?: SpanOptions, parentContext?: Context): Span {
    const tracer = this.getTracer();
    const ctx = parentContext ?? context.active();
    return tracer.startSpan(name, options, ctx);
  }

  /** Run `fn` with `ctx` as the active context (for async propagation). */
  withContext<T>(ctx: Context, fn: () => T): T {
    return context.with(ctx, fn);
  }

  /** Run async `fn` with `ctx` active; returns a Promise that resolves in the same context chain. */
  async withContextAsync<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
    return context.with(ctx, fn);
  }

  async shutdown(): Promise<void> {
    if (!this.sdk) return;
    try {
      await this.sdk.shutdown();
    } finally {
      this.sdk = null;
      this.apiTracer = null;
    }
  }
}
