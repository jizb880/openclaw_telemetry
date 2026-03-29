import { context, trace, type Context, type Span, type SpanOptions, type Tracer } from "@opentelemetry/api";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { resolveOtelSpanExportFilePath, type ObservabilityConfig } from "./config/observability.js";
import { JsonlFileSpanExporter } from "./exporters/jsonl-file-span-exporter.js";

const INSTRUMENTATION_NAME = "openclaw-otel-observability";
const INSTRUMENTATION_VERSION = "0.1.0";

/**
 * Global singleton around `trace.getTracer()` and the Node tracer provider lifecycle.
 * Spans use the active async context for automatic propagation.
 */
export class GlobalTracer {
  private static instance: GlobalTracer | undefined;

  private provider: NodeTracerProvider | null = null;
  private apiTracer: Tracer | null = null;

  private constructor() {}

  static getInstance(): GlobalTracer {
    if (!GlobalTracer.instance) GlobalTracer.instance = new GlobalTracer();
    return GlobalTracer.instance;
  }

  init(
    config: ObservabilityConfig,
    resolveExportPath: (cfg: ObservabilityConfig) => string | null = resolveOtelSpanExportFilePath
  ): void {
    if (!config.enabled) return;
    if (this.provider) return;

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
    });

    const otlpExporter = new OTLPTraceExporter({
      url: config.otlpEndpoint,
    });

    const spanProcessors = [new BatchSpanProcessor(otlpExporter)];

    const filePath = resolveExportPath(config);
    if (filePath) {
      spanProcessors.push(new BatchSpanProcessor(new JsonlFileSpanExporter(filePath)));
    }

    this.provider = new NodeTracerProvider({
      resource,
      spanProcessors,
    });

    this.provider.register();
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

  startSpan(name: string, options?: SpanOptions, parentContext?: Context): Span {
    const tracer = this.getTracer();
    const ctx = parentContext ?? context.active();
    return tracer.startSpan(name, options, ctx);
  }

  withContext<T>(ctx: Context, fn: () => T): T {
    return context.with(ctx, fn);
  }

  async withContextAsync<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
    return context.with(ctx, fn);
  }

  async shutdown(): Promise<void> {
    if (!this.provider) return;
    try {
      await this.provider.shutdown();
    } finally {
      this.provider = null;
      this.apiTracer = null;
    }
  }
}
