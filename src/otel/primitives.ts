import { randomFillSync } from "node:crypto";

/**
 * Native OpenTelemetry primitives — no third-party runtime dependency.
 *
 * These mirror the subset of the OTel API/SDK this plugin actually uses, with
 * the same names and numeric values as the spec so the emitted OTLP payloads are
 * indistinguishable from the official SDK's output.
 */

/** OTLP `SpanKind` enum values (trace proto). */
export const SpanKind = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;
export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];

/** OTLP `Status.StatusCode` enum values (trace proto). */
export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;
export type SpanStatusCodeValue = (typeof SpanStatusCode)[keyof typeof SpanStatusCode];

/** Attribute values OTLP can represent (we emit string/int/double/bool). */
export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue | undefined>;

export type SpanStatus = {
  code: SpanStatusCodeValue;
  message?: string;
};

export type SpanContext = {
  traceId: string;
  spanId: string;
  /** W3C trace flags; 1 = sampled. */
  traceFlags: number;
};

export type SpanOptions = {
  kind?: SpanKindValue;
  attributes?: Attributes;
  /** Explicit start time in epoch milliseconds; defaults to now. */
  startTime?: number;
};

/** The span surface the interceptors use. */
export interface Span {
  setAttribute(key: string, value: AttributeValue): this;
  setAttributes(attributes: Attributes): this;
  setStatus(status: SpanStatus): this;
  addEvent(name: string, attributes?: Attributes): this;
  recordException(error: unknown): this;
  spanContext(): SpanContext;
  isRecording(): boolean;
  end(endTime?: number): void;
}

// `Tracer` lives in ./context.ts because it references `Context`, which is
// defined there — keeping it out of this module avoids a circular type import.

const HEX = "0123456789abcdef";

function randomHex(bytes: number): string {
  const buf = Buffer.allocUnsafe(bytes);
  randomFillSync(buf);
  let out = "";
  for (let i = 0; i < bytes; i++) {
    const b = buf[i]!;
    out += HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
  }
  return out;
}

export const INVALID_TRACE_ID = "0".repeat(32);
export const INVALID_SPAN_ID = "0".repeat(16);

/** 16-byte trace id as 32 lowercase hex chars (never all-zero). */
export function generateTraceId(): string {
  let id = randomHex(16);
  while (id === INVALID_TRACE_ID) id = randomHex(16);
  return id;
}

/** 8-byte span id as 16 lowercase hex chars (never all-zero). */
export function generateSpanId(): string {
  let id = randomHex(8);
  while (id === INVALID_SPAN_ID) id = randomHex(8);
  return id;
}

export function isValidSpanContext(sc: SpanContext | undefined): sc is SpanContext {
  return (
    sc !== undefined &&
    typeof sc.traceId === "string" &&
    typeof sc.spanId === "string" &&
    sc.traceId.length === 32 &&
    sc.spanId.length === 16 &&
    sc.traceId !== INVALID_TRACE_ID &&
    sc.spanId !== INVALID_SPAN_ID
  );
}

/**
 * Epoch nanoseconds as a decimal string, which is how OTLP/JSON encodes
 * `startTimeUnixNano` / `endTimeUnixNano` (uint64 → JSON string).
 *
 * `Date.now()` only has millisecond resolution, so we derive sub-millisecond
 * precision from `performance.now()` — the same approach the official SDK takes
 * — to keep span durations meaningful and monotonic within a process.
 */
const epochMsAtOrigin = Date.now() - Math.round(performance.now());

/** Current time in fractional epoch milliseconds (sub-ms precision). */
export function nowEpochMs(): number {
  return epochMsAtOrigin + performance.now();
}

/** Convert fractional epoch milliseconds to an OTLP nanosecond string. */
export function epochMsToUnixNano(epochMs: number): string {
  const ms = Math.trunc(epochMs);
  // Keep the fractional millisecond as whole nanoseconds without float drift.
  const fracNs = Math.round((epochMs - ms) * 1e6);
  const total = BigInt(ms) * 1_000_000n + BigInt(fracNs);
  return total.toString();
}
