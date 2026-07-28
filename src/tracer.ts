import { resolveOtelSpanExportFilePath, type ObservabilityConfig } from "./config/observability.js";
import {
  BatchSpanProcessor,
  OtlpHttpSpanExporter,
  OtlpJsonFileSpanExporter,
  TracerProvider,
  context,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
} from "./otel/index.js";

const INSTRUMENTATION_NAME = "openclaw-otel-observability";
const INSTRUMENTATION_VERSION = "0.1.0";

export type TracerInitOptions = {
  /** Where export failures are reported. Defaults to silent. */
  onError?: (err: unknown) => void;
};

/**
 * Global singleton owning the tracer provider lifecycle.
 *
 * Backed by this package's native OpenTelemetry implementation (`src/otel`), so
 * there is no third-party OTel runtime dependency and no global SDK
 * registration that could clash with the host.
 */
export class GlobalTracer {
  private static instance: GlobalTracer | undefined;

  private provider: TracerProvider | null = null;
  private apiTracer: Tracer | null = null;

  private constructor() {}

  static getInstance(): GlobalTracer {
    if (!GlobalTracer.instance) GlobalTracer.instance = new GlobalTracer();
    return GlobalTracer.instance;
  }

  init(
    config: ObservabilityConfig,
    resolveExportPath: (cfg: ObservabilityConfig) => string | null = resolveOtelSpanExportFilePath,
    options: TracerInitOptions = {}
  ): void {
    if (!config.enabled) return;
    if (this.provider) return;

    const resource: { attributes: Attributes } = {
      attributes: { "service.name": config.serviceName },
    };
    const scope = { name: INSTRUMENTATION_NAME, version: INSTRUMENTATION_VERSION };
    const onError = options.onError ?? ((): void => {});

    const spanProcessors: BatchSpanProcessor[] = [];

    if (config.otlpEnabled) {
      spanProcessors.push(
        new BatchSpanProcessor(new OtlpHttpSpanExporter(config.otlpEndpoint, resource, scope), { onError })
      );
    }

    const filePath = resolveExportPath(config);
    if (filePath) {
      spanProcessors.push(
        new BatchSpanProcessor(new OtlpJsonFileSpanExporter(filePath, resource, scope), { onError })
      );
    }

    this.provider = new TracerProvider({ resource, scope, spanProcessors });
    this.apiTracer = this.provider.getTracer();
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

  /** Push all buffered spans to the configured exporters without tearing down. */
  async forceFlush(): Promise<void> {
    await this.provider?.forceFlush();
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
