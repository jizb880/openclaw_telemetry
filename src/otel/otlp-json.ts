import type { ReadableSpan } from "./span.js";
import type { AttributeValue, Attributes } from "./primitives.js";

/** OTLP/JSON `AnyValue`. */
type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: number }
  | { doubleValue: number };

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type OtlpExportTraceServiceRequest = {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[]; droppedAttributesCount: number };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: Array<Record<string, unknown>>;
    }>;
  }>;
};

/**
 * Encode one attribute value as an OTLP `AnyValue`.
 *
 * Integers must use `intValue` and non-integers `doubleValue` — the proto's JSON
 * mapping keeps them distinct, and collectors reject a float in `intValue`.
 */
function toAnyValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
}

function toKeyValues(attributes: Attributes): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    out.push({ key, value: toAnyValue(value) });
  }
  return out;
}

export type SerializerScope = { name: string; version: string };
export type SerializerResource = { attributes: Attributes };

/**
 * Build a standard OTLP/JSON `ExportTraceServiceRequest` for a batch of spans.
 *
 * The output is byte-compatible with what the official OTLP HTTP exporter sends,
 * so the same payload works for both the network exporter and the NDJSON file
 * (consumable by the OTel Collector's `otlpjsonfile` receiver).
 */
export function buildExportTraceServiceRequest(
  spans: readonly ReadableSpan[],
  resource: SerializerResource,
  scope: SerializerScope
): OtlpExportTraceServiceRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: toKeyValues(resource.attributes),
          droppedAttributesCount: 0,
        },
        scopeSpans: [
          {
            scope: { name: scope.name, version: scope.version },
            spans: spans.map((s) => ({
              traceId: s.spanContext.traceId,
              spanId: s.spanContext.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: s.startTimeUnixNano,
              endTimeUnixNano: s.endTimeUnixNano,
              attributes: toKeyValues(s.attributes),
              droppedAttributesCount: 0,
              events: s.events.map((e) => ({
                timeUnixNano: e.timeUnixNano,
                name: e.name,
                attributes: toKeyValues(e.attributes),
                droppedAttributesCount: 0,
              })),
              droppedEventsCount: 0,
              status:
                s.status.message === undefined
                  ? { code: s.status.code }
                  : { code: s.status.code, message: s.status.message },
              links: [],
              droppedLinksCount: 0,
            })),
          },
        ],
      },
    ],
  };
}

/** Serialize a batch to a single-line OTLP/JSON string (one NDJSON record). */
export function serializeSpansToOtlpJson(
  spans: readonly ReadableSpan[],
  resource: SerializerResource,
  scope: SerializerScope
): string {
  return JSON.stringify(buildExportTraceServiceRequest(spans, resource, scope));
}
