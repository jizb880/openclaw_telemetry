import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { Attributes, HrTime } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

function hrToNanos(t: HrTime): string {
  return String(BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]));
}

function serializeAttributes(attrs: Attributes): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = v;
  }
  return out;
}

/** One JSON object per line, OpenTelemetry-style span snapshot. */
function spanToJsonLine(span: ReadableSpan): string {
  const sc = span.spanContext();
  const rec: Record<string, unknown> = {
    name: span.name,
    kind: span.kind as number,
    traceId: sc.traceId,
    spanId: sc.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    startTimeUnixNano: hrToNanos(span.startTime),
    endTimeUnixNano: hrToNanos(span.endTime),
    durationUnixNano: hrToNanos(span.duration),
    attributes: serializeAttributes(span.attributes),
    status: span.status,
    events: span.events.map((e) => ({
      name: e.name,
      timeUnixNano: hrToNanos(e.time),
      attributes: e.attributes ? serializeAttributes(e.attributes as Attributes) : {},
    })),
    resource: serializeAttributes(span.resource.attributes),
    instrumentationScope: {
      name: span.instrumentationScope.name,
      version: span.instrumentationScope.version,
    },
  };
  return `${JSON.stringify(rec)}\n`;
}

/**
 * Appends exported spans as NDJSON (one span JSON per line) for local inspection / pipelines.
 */
export class JsonlFileSpanExporter implements SpanExporter {
  constructor(private readonly filePath: string) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      let buf = "";
      for (const span of spans) {
        buf += spanToJsonLine(span);
      }
      appendFileSync(this.filePath, buf, "utf8");
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
