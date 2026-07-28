/**
 * Native OpenTelemetry implementation for this plugin.
 *
 * Re-exports the API surface the interceptors use, so a module can do
 * `import { SpanKind, SpanStatusCode, context, trace } from "../otel/index.js"`
 * exactly as it previously imported from `@opentelemetry/api`.
 */

export {
  SpanKind,
  SpanStatusCode,
  generateSpanId,
  generateTraceId,
  isValidSpanContext,
  epochMsToUnixNano,
  nowEpochMs,
  INVALID_SPAN_ID,
  INVALID_TRACE_ID,
  type AttributeValue,
  type Attributes,
  type Span,
  type SpanContext,
  type SpanKindValue,
  type SpanOptions,
  type SpanStatus,
  type SpanStatusCodeValue,
} from "./primitives.js";

export {
  ROOT_CONTEXT,
  context,
  trace,
  type Context,
  type ContextKey,
  type Tracer,
} from "./context.js";

export { SpanImpl, createSpan, type OnSpanEnd, type ReadableSpan, type SpanEvent } from "./span.js";

export {
  buildExportTraceServiceRequest,
  serializeSpansToOtlpJson,
  type OtlpExportTraceServiceRequest,
  type SerializerResource,
  type SerializerScope,
} from "./otlp-json.js";

export {
  OtlpHttpSpanExporter,
  OtlpJsonFileSpanExporter,
  type SpanExporter,
} from "./exporters.js";

export { BatchSpanProcessor, type BatchSpanProcessorOptions } from "./batch-processor.js";

export { TracerProvider, type TracerProviderOptions } from "./provider.js";
