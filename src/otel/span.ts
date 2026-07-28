import { trace, type Context } from "./context.js";
import {
  epochMsToUnixNano,
  generateSpanId,
  generateTraceId,
  isValidSpanContext,
  nowEpochMs,
  SpanKind,
  SpanStatusCode,
  type AttributeValue,
  type Attributes,
  type Span,
  type SpanContext,
  type SpanKindValue,
  type SpanOptions,
  type SpanStatus,
} from "./primitives.js";

export type SpanEvent = {
  name: string;
  timeUnixNano: string;
  attributes: Attributes;
};

/** A finished span, in the shape exporters serialize. */
export type ReadableSpan = {
  name: string;
  kind: SpanKindValue;
  spanContext: SpanContext;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attributes;
  events: SpanEvent[];
  status: SpanStatus;
};

/** Callback the provider passes in so ended spans reach the processors. */
export type OnSpanEnd = (span: ReadableSpan) => void;

/**
 * A recording span. Mutations after `end()` are ignored, matching the OTel spec
 * (and preventing late hook callbacks from corrupting exported data).
 */
export class SpanImpl implements Span {
  private readonly _spanContext: SpanContext;
  private readonly _attributes: Attributes = {};
  private readonly _events: SpanEvent[] = [];
  private _status: SpanStatus = { code: SpanStatusCode.UNSET };
  private readonly _startEpochMs: number;
  private _ended = false;

  constructor(
    private readonly _name: string,
    private readonly _kind: SpanKindValue,
    spanContext: SpanContext,
    private readonly _parentSpanId: string | undefined,
    private readonly _onEnd: OnSpanEnd,
    attributes?: Attributes,
    startEpochMs?: number
  ) {
    this._spanContext = spanContext;
    this._startEpochMs = startEpochMs ?? nowEpochMs();
    if (attributes) this.setAttributes(attributes);
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (this._ended || value === undefined || value === null) return this;
    this._attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    for (const [k, v] of Object.entries(attributes)) {
      if (v !== undefined) this.setAttribute(k, v);
    }
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (this._ended) return this;
    this._status = status.message === undefined ? { code: status.code } : { ...status };
    return this;
  }

  addEvent(name: string, attributes?: Attributes): this {
    if (this._ended) return this;
    this._events.push({
      name,
      timeUnixNano: epochMsToUnixNano(nowEpochMs()),
      attributes: attributes ? { ...attributes } : {},
    });
    return this;
  }

  recordException(error: unknown): this {
    if (this._ended) return this;
    const message = error instanceof Error ? error.message : String(error);
    const attrs: Attributes = { "exception.message": message };
    if (error instanceof Error) {
      if (error.name) attrs["exception.type"] = error.name;
      if (error.stack) attrs["exception.stacktrace"] = error.stack;
    }
    return this.addEvent("exception", attrs);
  }

  spanContext(): SpanContext {
    return this._spanContext;
  }

  isRecording(): boolean {
    return !this._ended;
  }

  end(endEpochMs?: number): void {
    if (this._ended) return;
    this._ended = true;
    const end = endEpochMs ?? nowEpochMs();
    this._onEnd({
      name: this._name,
      kind: this._kind,
      spanContext: this._spanContext,
      ...(this._parentSpanId ? { parentSpanId: this._parentSpanId } : {}),
      startTimeUnixNano: epochMsToUnixNano(this._startEpochMs),
      endTimeUnixNano: epochMsToUnixNano(end),
      attributes: { ...this._attributes },
      events: [...this._events],
      status: this._status,
    });
  }
}

/**
 * Create a span, inheriting trace id from the parent span in `parentContext`
 * when there is one and starting a new trace otherwise.
 */
export function createSpan(
  name: string,
  options: SpanOptions | undefined,
  parentContext: Context | undefined,
  onEnd: OnSpanEnd
): Span {
  const parentSpanContext = parentContext ? trace.getSpan(parentContext)?.spanContext() : undefined;
  const hasParent = isValidSpanContext(parentSpanContext);

  const spanContext: SpanContext = {
    traceId: hasParent ? parentSpanContext.traceId : generateTraceId(),
    spanId: generateSpanId(),
    traceFlags: 1,
  };

  return new SpanImpl(
    name,
    options?.kind ?? SpanKind.INTERNAL,
    spanContext,
    hasParent ? parentSpanContext.spanId : undefined,
    onEnd,
    options?.attributes,
    options?.startTime
  );
}
