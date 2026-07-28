import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BatchSpanProcessor,
  OtlpHttpSpanExporter,
  OtlpJsonFileSpanExporter,
  SpanKind,
  SpanStatusCode,
  TracerProvider,
  buildExportTraceServiceRequest,
  context,
  trace,
  type Attributes,
  type ReadableSpan,
} from "../src/otel/index.js";

/**
 * Direct tests for the native OTLP implementation — the pieces the hook E2E
 * suite exercises only indirectly (HTTP export) or not at all (encoder edge
 * cases, context propagation, span immutability after end).
 */

const RESOURCE: { attributes: Attributes } = { attributes: { "service.name": "openclaw-test" } };
const SCOPE = { name: "openclaw-otel-observability", version: "0.1.0" };

const tmpDirs: string[] = [];
function newTmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-otlp-"));
  tmpDirs.push(dir);
  return join(dir, "spans.jsonl");
}

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Build a provider whose spans land in a local NDJSON file. */
function fileProvider(file: string): { provider: TracerProvider; read: () => string[] } {
  const processor = new BatchSpanProcessor(new OtlpJsonFileSpanExporter(file, RESOURCE, SCOPE), {
    onError: (e) => {
      throw e;
    },
  });
  const provider = new TracerProvider({ resource: RESOURCE, scope: SCOPE, spanProcessors: [processor] });
  return {
    provider,
    read: () => {
      try {
        return readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
      } catch {
        return [];
      }
    },
  };
}

describe("OTLP/JSON encoder", () => {
  const baseSpan: ReadableSpan = {
    name: "test.span",
    kind: SpanKind.CLIENT,
    spanContext: { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 },
    parentSpanId: "c".repeat(16),
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000500000000",
    attributes: {},
    events: [],
    status: { code: SpanStatusCode.UNSET },
  };

  it("emits the OTLP resourceSpans/scopeSpans envelope", () => {
    const req = buildExportTraceServiceRequest([baseSpan], RESOURCE, SCOPE);
    assert.equal(req.resourceSpans.length, 1);
    const rs = req.resourceSpans[0]!;
    assert.deepEqual(rs.resource.attributes, [
      { key: "service.name", value: { stringValue: "openclaw-test" } },
    ]);
    assert.equal(rs.resource.droppedAttributesCount, 0);
    assert.deepEqual(rs.scopeSpans[0]!.scope, SCOPE);
  });

  it("preserves ids, kind, timestamps and parent linkage", () => {
    const s = buildExportTraceServiceRequest([baseSpan], RESOURCE, SCOPE)
      .resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    assert.equal(s.traceId, "a".repeat(32));
    assert.equal(s.spanId, "b".repeat(16));
    assert.equal(s.parentSpanId, "c".repeat(16));
    assert.equal(s.kind, SpanKind.CLIENT);
    assert.equal(s.startTimeUnixNano, "1700000000000000000");
    assert.equal(s.endTimeUnixNano, "1700000000500000000");
  });

  it("omits parentSpanId for a root span", () => {
    const { parentSpanId, ...root } = baseSpan;
    const s = buildExportTraceServiceRequest([root as ReadableSpan], RESOURCE, SCOPE)
      .resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    assert.ok(!("parentSpanId" in s), "root span must not carry parentSpanId");
  });

  it("types attribute values per the OTLP AnyValue mapping", () => {
    const s = buildExportTraceServiceRequest(
      [
        {
          ...baseSpan,
          attributes: { str: "x", int: 42, negInt: -7, dbl: 1.5, boolT: true, boolF: false },
        },
      ],
      RESOURCE,
      SCOPE
    ).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const byKey = Object.fromEntries(
      (s.attributes as Array<{ key: string; value: unknown }>).map((a) => [a.key, a.value])
    );
    assert.deepEqual(byKey.str, { stringValue: "x" });
    assert.deepEqual(byKey.int, { intValue: 42 });
    assert.deepEqual(byKey.negInt, { intValue: -7 });
    // Non-integers must use doubleValue — collectors reject a float in intValue.
    assert.deepEqual(byKey.dbl, { doubleValue: 1.5 });
    assert.deepEqual(byKey.boolT, { boolValue: true });
    assert.deepEqual(byKey.boolF, { boolValue: false });
  });

  it("drops undefined attributes rather than emitting null values", () => {
    const s = buildExportTraceServiceRequest(
      [{ ...baseSpan, attributes: { keep: "yes", skip: undefined } }],
      RESOURCE,
      SCOPE
    ).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const keys = (s.attributes as Array<{ key: string }>).map((a) => a.key);
    assert.deepEqual(keys, ["keep"]);
  });

  it("emits status with a message only when set", () => {
    const unset = buildExportTraceServiceRequest([baseSpan], RESOURCE, SCOPE)
      .resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    assert.deepEqual(unset.status, { code: 0 });

    const errored = buildExportTraceServiceRequest(
      [{ ...baseSpan, status: { code: SpanStatusCode.ERROR, message: "boom" } }],
      RESOURCE,
      SCOPE
    ).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    assert.deepEqual(errored.status, { code: 2, message: "boom" });
  });

  it("serializes to a single NDJSON line", () => {
    const file = newTmpFile();
    const { provider, read } = fileProvider(file);
    const tracer = provider.getTracer();
    tracer.startSpan("one").end();
    tracer.startSpan("two").end();
    return provider.forceFlush().then(() => {
      const lines = read();
      assert.equal(lines.length, 1, "one batch → one line");
      const parsed = JSON.parse(lines[0]!);
      assert.equal(parsed.resourceSpans[0].scopeSpans[0].spans.length, 2);
    });
  });
});

describe("span behavior", () => {
  it("inherits the trace id from the parent and links parentSpanId", async () => {
    const file = newTmpFile();
    const { provider, read } = fileProvider(file);
    const tracer = provider.getTracer();

    const parent = tracer.startSpan("parent");
    const childCtx = trace.setSpan(context.active(), parent);
    const child = tracer.startSpan("child", undefined, childCtx);
    child.end();
    parent.end();

    await provider.forceFlush();
    const spans = JSON.parse(read()[0]!).resourceSpans[0].scopeSpans[0].spans as Array<
      Record<string, string>
    >;
    const c = spans.find((s) => s.name === "child")!;
    const p = spans.find((s) => s.name === "parent")!;
    assert.equal(c.traceId, p.traceId, "child must share the parent trace id");
    assert.equal(c.parentSpanId, p.spanId, "child must point at the parent span id");
    assert.ok(!("parentSpanId" in p), "parent is a root span");
  });

  it("starts a new trace when there is no parent", async () => {
    const file = newTmpFile();
    const { provider, read } = fileProvider(file);
    const tracer = provider.getTracer();
    tracer.startSpan("a").end();
    tracer.startSpan("b").end();
    await provider.forceFlush();
    const spans = JSON.parse(read()[0]!).resourceSpans[0].scopeSpans[0].spans as Array<
      Record<string, string>
    >;
    assert.notEqual(spans[0]!.traceId, spans[1]!.traceId, "unrelated spans get distinct traces");
  });

  it("generates well-formed, unique ids", async () => {
    const file = newTmpFile();
    const { provider, read } = fileProvider(file);
    const tracer = provider.getTracer();
    for (let i = 0; i < 50; i++) tracer.startSpan(`s${i}`).end();
    await provider.forceFlush();
    const spans = JSON.parse(read()[0]!).resourceSpans[0].scopeSpans[0].spans as Array<
      Record<string, string>
    >;
    const spanIds = new Set<string>();
    for (const s of spans) {
      assert.match(s.traceId!, /^[0-9a-f]{32}$/, "trace id must be 32 lowercase hex chars");
      assert.match(s.spanId!, /^[0-9a-f]{16}$/, "span id must be 16 lowercase hex chars");
      assert.notEqual(s.traceId, "0".repeat(32));
      assert.notEqual(s.spanId, "0".repeat(16));
      spanIds.add(s.spanId!);
    }
    assert.equal(spanIds.size, spans.length, "span ids must be unique");
  });

  it("ignores mutations after end() so exported data cannot be corrupted", async () => {
    const file = newTmpFile();
    const { provider, read } = fileProvider(file);
    const span = provider.getTracer().startSpan("s", { attributes: { keep: 1 } });
    span.end();
    // A late hook callback must not alter the already-exported span.
    span.setAttribute("late", "nope");
    span.setStatus({ code: SpanStatusCode.ERROR, message: "late" });
    assert.equal(span.isRecording(), false);

    await provider.forceFlush();
    const s = JSON.parse(read()[0]!).resourceSpans[0].scopeSpans[0].spans[0]!;
    const keys = (s.attributes as Array<{ key: string }>).map((a) => a.key);
    assert.deepEqual(keys, ["keep"]);
    assert.deepEqual(s.status, { code: 0 });
  });

  it("is idempotent on repeated end()", async () => {
    const file = newTmpFile();
    const { provider, read } = fileProvider(file);
    const span = provider.getTracer().startSpan("once");
    span.end();
    span.end();
    span.end();
    await provider.forceFlush();
    const spans = JSON.parse(read()[0]!).resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 1, "a span must be exported exactly once");
  });

  it("records end after start with nanosecond-precision timestamps", async () => {
    const file = newTmpFile();
    const { provider, read } = fileProvider(file);
    const span = provider.getTracer().startSpan("timed");
    span.end();
    await provider.forceFlush();
    const s = JSON.parse(read()[0]!).resourceSpans[0].scopeSpans[0].spans[0]!;
    assert.match(s.startTimeUnixNano, /^\d+$/, "must be a uint64 decimal string");
    assert.match(s.endTimeUnixNano, /^\d+$/);
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano), "end must not precede start");
    // Sanity-check the epoch is plausible (year > 2020).
    assert.ok(BigInt(s.startTimeUnixNano) > 1_577_836_800_000_000_000n);
  });

  it("records exceptions as OTLP events", async () => {
    const file = newTmpFile();
    const { provider, read } = fileProvider(file);
    const span = provider.getTracer().startSpan("boom");
    span.recordException(new TypeError("bad input"));
    span.end();
    await provider.forceFlush();
    const s = JSON.parse(read()[0]!).resourceSpans[0].scopeSpans[0].spans[0]!;
    assert.equal(s.events.length, 1);
    assert.equal(s.events[0].name, "exception");
    const attrs = Object.fromEntries(
      (s.events[0].attributes as Array<{ key: string; value: { stringValue?: string } }>).map((a) => [
        a.key,
        a.value.stringValue,
      ])
    );
    assert.equal(attrs["exception.type"], "TypeError");
    assert.equal(attrs["exception.message"], "bad input");
  });
});

describe("context propagation", () => {
  it("exposes the active span inside context.with", () => {
    const { provider } = fileProvider(newTmpFile());
    const span = provider.getTracer().startSpan("active");
    const ctx = trace.setSpan(context.active(), span);
    assert.equal(trace.getSpan(context.active()), undefined, "no ambient span by default");
    context.with(ctx, () => {
      assert.equal(trace.getSpan(context.active()), span);
    });
    assert.equal(trace.getSpan(context.active()), undefined, "context must not leak out");
    span.end();
  });

  it("propagates across await boundaries", async () => {
    const { provider } = fileProvider(newTmpFile());
    const span = provider.getTracer().startSpan("async");
    const ctx = trace.setSpan(context.active(), span);
    await context.with(ctx, async () => {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(trace.getSpan(context.active()), span, "span must survive an await");
    });
    span.end();
  });

  it("treats contexts as immutable", () => {
    const { provider } = fileProvider(newTmpFile());
    const span = provider.getTracer().startSpan("imm");
    const base = context.active();
    const derived = trace.setSpan(base, span);
    assert.notEqual(base, derived);
    assert.equal(trace.getSpan(base), undefined, "setSpan must not mutate the source context");
    assert.equal(trace.getSpan(trace.deleteSpan(derived)), undefined);
    span.end();
  });
});

describe("OTLP HTTP exporter", () => {
  /** Start a throwaway OTLP receiver and return its URL plus captured bodies. */
  async function startReceiver(
    handler?: (body: string) => { status: number } | void
  ): Promise<{ url: string; bodies: string[]; contentTypes: string[]; close: () => Promise<void> }> {
    const bodies: string[] = [];
    const contentTypes: string[] = [];
    const server: Server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        bodies.push(data);
        contentTypes.push(String(req.headers["content-type"] ?? ""));
        const out = handler?.(data);
        res.writeHead(out?.status ?? 200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return {
      url: `http://127.0.0.1:${port}/v1/traces`,
      bodies,
      contentTypes,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const sampleSpan: ReadableSpan = {
    name: "http.span",
    kind: SpanKind.INTERNAL,
    spanContext: { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 },
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000000001000",
    attributes: { "openclaw.hook": "llm_input" },
    events: [],
    status: { code: SpanStatusCode.OK },
  };

  it("POSTs valid OTLP/JSON with the right content type", async () => {
    const rx = await startReceiver();
    try {
      await new OtlpHttpSpanExporter(rx.url, RESOURCE, SCOPE).export([sampleSpan]);
      assert.equal(rx.bodies.length, 1);
      assert.match(rx.contentTypes[0]!, /application\/json/);
      const parsed = JSON.parse(rx.bodies[0]!);
      const s = parsed.resourceSpans[0].scopeSpans[0].spans[0];
      assert.equal(s.name, "http.span");
      assert.equal(s.traceId, "1".repeat(32));
      assert.deepEqual(parsed.resourceSpans[0].resource.attributes, [
        { key: "service.name", value: { stringValue: "openclaw-test" } },
      ]);
    } finally {
      await rx.close();
    }
  });

  it("sends the same payload the file exporter writes", async () => {
    const rx = await startReceiver();
    const file = newTmpFile();
    try {
      await new OtlpHttpSpanExporter(rx.url, RESOURCE, SCOPE).export([sampleSpan]);
      await new OtlpJsonFileSpanExporter(file, RESOURCE, SCOPE).export([sampleSpan]);
      const fileLine = readFileSync(file, "utf8").trim();
      assert.equal(rx.bodies[0], fileLine, "HTTP body and NDJSON line must be identical");
    } finally {
      await rx.close();
    }
  });

  it("rejects on a non-2xx response so the processor can report it", async () => {
    const rx = await startReceiver(() => ({ status: 503 }));
    try {
      await assert.rejects(
        () => new OtlpHttpSpanExporter(rx.url, RESOURCE, SCOPE).export([sampleSpan]),
        /503/
      );
    } finally {
      await rx.close();
    }
  });

  it("does not call the endpoint for an empty batch", async () => {
    const rx = await startReceiver();
    try {
      await new OtlpHttpSpanExporter(rx.url, RESOURCE, SCOPE).export([]);
      assert.equal(rx.bodies.length, 0);
    } finally {
      await rx.close();
    }
  });

  it("surfaces export failures through the processor onError instead of throwing", async () => {
    const errors: unknown[] = [];
    // Port 1 is not listenable; the connection must fail.
    const processor = new BatchSpanProcessor(
      new OtlpHttpSpanExporter("http://127.0.0.1:1/v1/traces", RESOURCE, SCOPE, 500),
      { onError: (e) => errors.push(e) }
    );
    const provider = new TracerProvider({
      resource: RESOURCE,
      scope: SCOPE,
      spanProcessors: [processor],
    });
    provider.getTracer().startSpan("doomed").end();
    await provider.forceFlush();
    assert.equal(errors.length, 1, "a failed export must be reported, not thrown");
  });
});

describe("batch processor", () => {
  it("flushes to multiple processors from one provider", async () => {
    const f1 = newTmpFile();
    const f2 = newTmpFile();
    const provider = new TracerProvider({
      resource: RESOURCE,
      scope: SCOPE,
      spanProcessors: [
        new BatchSpanProcessor(new OtlpJsonFileSpanExporter(f1, RESOURCE, SCOPE)),
        new BatchSpanProcessor(new OtlpJsonFileSpanExporter(f2, RESOURCE, SCOPE)),
      ],
    });
    provider.getTracer().startSpan("fanout").end();
    await provider.forceFlush();
    for (const f of [f1, f2]) {
      const spans = JSON.parse(readFileSync(f, "utf8").trim()).resourceSpans[0].scopeSpans[0].spans;
      assert.equal(spans.length, 1, "each exporter receives the span");
    }
  });

  it("splits oversized queues into multiple batches", async () => {
    const file = newTmpFile();
    const processor = new BatchSpanProcessor(new OtlpJsonFileSpanExporter(file, RESOURCE, SCOPE), {
      maxExportBatchSize: 2,
    });
    const provider = new TracerProvider({
      resource: RESOURCE,
      scope: SCOPE,
      spanProcessors: [processor],
    });
    const tracer = provider.getTracer();
    for (let i = 0; i < 5; i++) tracer.startSpan(`s${i}`).end();
    await provider.forceFlush();

    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    const total = lines.reduce(
      (n, l) => n + JSON.parse(l).resourceSpans[0].scopeSpans[0].spans.length,
      0
    );
    assert.equal(total, 5, "no spans may be lost when batching");
    assert.ok(lines.length >= 2, "5 spans at batch size 2 must span multiple batches");
  });

  it("drops spans past the queue cap instead of growing without bound", async () => {
    const errors: unknown[] = [];
    const file = newTmpFile();
    const processor = new BatchSpanProcessor(new OtlpJsonFileSpanExporter(file, RESOURCE, SCOPE), {
      maxQueueSize: 3,
      maxExportBatchSize: 100,
      onError: (e) => errors.push(e),
    });
    const provider = new TracerProvider({
      resource: RESOURCE,
      scope: SCOPE,
      spanProcessors: [processor],
    });
    const tracer = provider.getTracer();
    for (let i = 0; i < 6; i++) tracer.startSpan(`s${i}`).end();
    assert.equal(errors.length, 3, "overflow must be reported");
    await provider.forceFlush();
    const total = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .reduce((n, l) => n + JSON.parse(l).resourceSpans[0].scopeSpans[0].spans.length, 0);
    assert.equal(total, 3, "only the capped number of spans is exported");
  });

  it("flushes pending spans on shutdown", async () => {
    const file = newTmpFile();
    const provider = new TracerProvider({
      resource: RESOURCE,
      scope: SCOPE,
      spanProcessors: [new BatchSpanProcessor(new OtlpJsonFileSpanExporter(file, RESOURCE, SCOPE))],
    });
    provider.getTracer().startSpan("pending").end();
    await provider.shutdown();
    const spans = JSON.parse(readFileSync(file, "utf8").trim()).resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 1, "shutdown must not lose buffered spans");
  });

  it("writes nothing when no spans were recorded", async () => {
    const file = newTmpFile();
    const { provider, read } = fileProvider(file);
    await provider.forceFlush();
    assert.deepEqual(read(), [], "an empty flush must not write a line");
  });
});
