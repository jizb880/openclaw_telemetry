import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";

const textDecoder = new TextDecoder();

/**
 * Appends exported spans as NDJSON: one OTLP/JSON `ExportTraceServiceRequest`
 * per line (identical payload to what the OTLP HTTP exporter sends), so the
 * file can be consumed by standard tooling such as the OTel Collector's
 * `otlpjsonfile` receiver.
 */
export class JsonlFileSpanExporter implements SpanExporter {
  constructor(private readonly filePath: string) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      if (spans.length > 0) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const serialized = JsonTraceSerializer.serializeRequest(spans);
        appendFileSync(this.filePath, `${textDecoder.decode(serialized)}\n`, "utf8");
      }
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
