import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serializeSpansToOtlpJson, type SerializerResource, type SerializerScope } from "./otlp-json.js";
import type { ReadableSpan } from "./span.js";

/** A destination for finished span batches. */
export interface SpanExporter {
  export(spans: readonly ReadableSpan[]): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Appends each batch as one OTLP/JSON `ExportTraceServiceRequest` per line
 * (NDJSON). Identical payload to the HTTP exporter, so the file can be consumed
 * by standard tooling such as the Collector's `otlpjsonfile` receiver.
 */
export class OtlpJsonFileSpanExporter implements SpanExporter {
  private dirEnsured = false;

  constructor(
    private readonly filePath: string,
    private readonly resource: SerializerResource,
    private readonly scope: SerializerScope
  ) {}

  async export(spans: readonly ReadableSpan[]): Promise<void> {
    if (spans.length === 0) return;
    if (!this.dirEnsured) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.dirEnsured = true;
    }
    const line = serializeSpansToOtlpJson(spans, this.resource, this.scope);
    appendFileSync(this.filePath, `${line}\n`, "utf8");
  }

  async shutdown(): Promise<void> {
    /* nothing buffered here */
  }
}

/**
 * Posts each batch to an OTLP/HTTP traces endpoint as `application/json`.
 *
 * Uses global `fetch` (Node 18+). Export failures are surfaced to the caller,
 * which logs and drops the batch — telemetry must never break the host.
 */
export class OtlpHttpSpanExporter implements SpanExporter {
  constructor(
    private readonly url: string,
    private readonly resource: SerializerResource,
    private readonly scope: SerializerScope,
    private readonly timeoutMs = 10_000,
    private readonly headers: Record<string, string> = {}
  ) {}

  async export(spans: readonly ReadableSpan[]): Promise<void> {
    if (spans.length === 0) return;
    const body = serializeSpansToOtlpJson(spans, this.resource, this.scope);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`OTLP HTTP export failed: ${res.status} ${res.statusText}`);
      }
      // Drain the body so the socket can be reused.
      await res.arrayBuffer().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(): Promise<void> {
    /* nothing buffered here */
  }
}
