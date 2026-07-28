import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseObservabilityConfig, type ObservabilityConfig } from "../../src/config/observability.js";
import { registerInterceptors } from "../../src/interceptors/index.js";
import { modelCallSpans, sessionState, toolStacks } from "../../src/interceptors/state.js";
import { GlobalTracer } from "../../src/tracer.js";
import { createMockHost, MODERN_HOST, type HostProfile, type MockHost } from "./mock-host.js";
import * as f from "./fixtures.js";

/** One span, decoded out of the OTLP/JSON NDJSON the plugin writes. */
export type CapturedSpan = {
  name: string;
  kind: number;
  attributes: Record<string, unknown>;
  status?: { code?: number; message?: string };
  traceId: string;
  spanId: string;
  parentSpanId?: string;
};

let tmpDir: string | undefined;
let spanFile: string | undefined;
let tracerReady = false;

/**
 * The plugin's tracer is a process-wide singleton wrapping a registered
 * OpenTelemetry provider, so we initialize it exactly once per test process and
 * separate scenarios by session key instead of re-registering providers.
 *
 * `otlpEnabled: false` keeps the run fully offline — NDJSON file export only.
 */
function ensureTracer(): { gt: GlobalTracer; file: string } {
  if (!tracerReady) {
    tmpDir = mkdtempSync(join(tmpdir(), "openclaw-otel-e2e-"));
    spanFile = join(tmpDir, "spans.jsonl");
    const cfg = parseObservabilityConfig({
      otlpEnabled: false,
      otelSpanExportEnabled: true,
      otelSpanExportPath: spanFile,
    });
    GlobalTracer.getInstance().init(cfg, () => spanFile!);
    tracerReady = true;
  }
  return { gt: GlobalTracer.getInstance(), file: spanFile! };
}

/** Flush buffered spans and decode every span written so far. */
export async function flushAndReadSpans(): Promise<CapturedSpan[]> {
  const { gt, file } = ensureTracer();
  await gt.forceFlush();
  if (!existsSync(file)) return [];

  const out: CapturedSpan[] = [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const req = JSON.parse(line) as {
      resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }>;
    };
    for (const rs of req.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const raw of ss.spans ?? []) {
          const s = raw as Record<string, any>;
          const attributes: Record<string, unknown> = {};
          for (const kv of (s.attributes ?? []) as Array<{ key: string; value: Record<string, unknown> }>) {
            const v = kv.value ?? {};
            attributes[kv.key] =
              v.stringValue ??
              (v.intValue !== undefined ? Number(v.intValue) : undefined) ??
              v.boolValue ??
              (v.doubleValue !== undefined ? Number(v.doubleValue) : undefined) ??
              undefined;
          }
          out.push({
            name: s.name,
            kind: s.kind,
            attributes,
            status: s.status,
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId,
          });
        }
      }
    }
  }
  return out;
}

/** Raw NDJSON lines exactly as exported (used to publish samples). */
export async function flushAndReadRawLines(): Promise<string[]> {
  const { gt, file } = ensureTracer();
  await gt.forceFlush();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

export function cleanupTracerTmp(): void {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

/** Clear cross-scenario interceptor state so scenarios stay independent. */
function resetInterceptorState(): void {
  sessionState.clear();
  toolStacks.clear();
  modelCallSpans.clear();
}

export type ScenarioOptions = {
  profile?: HostProfile;
  config?: Partial<ObservabilityConfig>;
  /** Suffix appended to the fixture session key so scenarios don't collide. */
  sessionKeySuffix?: string;
  /** Include the failing-tool leg of the turn. */
  includeToolError?: boolean;
  /** Include the compaction cycle. */
  includeCompaction?: boolean;
};

export type ScenarioResult = {
  host: MockHost;
  sessionKey: string;
  /** Hook names the plugin successfully registered on this host profile. */
  registeredHookNames: string[];
  /** Hook names this host profile refused, with reasons. */
  rejected: Array<{ hookName: string; reason: string }>;
  /** Hook names actually dispatched during the run. */
  dispatched: string[];
};

/**
 * Drive one complete agent turn through the plugin, in the order OpenClaw fires
 * hooks: session → inbound message → prompt build → input gate → LLM input →
 * provider call → LLM output → tool call → tool persist → compaction →
 * outbound message → agent end → session end.
 *
 * Hooks the host profile does not know are skipped, exactly as on a real host.
 */
export async function runScenario(opts: ScenarioOptions = {}): Promise<ScenarioResult> {
  const profile = opts.profile ?? MODERN_HOST;
  const { gt } = ensureTracer();
  resetInterceptorState();

  const cfg = parseObservabilityConfig({ otlpEnabled: false, ...(opts.config ?? {}) });
  const host = createMockHost(profile);
  registerInterceptors(host.api as never, gt, cfg);

  const sessionKey = opts.sessionKeySuffix ? `${f.SESSION_KEY}#${opts.sessionKeySuffix}` : f.SESSION_KEY;
  const withKey = <T extends object>(o: T): T & { sessionKey: string } => ({ ...o, sessionKey });
  const ctx = <T extends object>(o: T): T & { sessionKey: string } => ({ ...o, sessionKey });

  const dispatched: string[] = [];
  const fire = async (name: string, event: unknown, hookCtx: unknown): Promise<void> => {
    if (!host.hasHooks(name)) return;
    dispatched.push(name);
    await host.dispatch(name, event, hookCtx);
  };

  await fire("session_start", withKey(f.sessionStartEvent), ctx(f.sessionCtx));
  await fire("message_received", withKey(f.messageReceivedEvent), ctx(f.messageCtx));
  await fire("before_agent_start", withKey(f.beforeAgentStartEvent), ctx(f.agentCtx));
  await fire("before_agent_run", withKey(f.beforeAgentRunEvent), ctx(f.agentCtx));
  await fire("llm_input", withKey(f.llmInputEvent), ctx(f.agentCtx));
  await fire("model_call_started", withKey(f.modelCallStartedEvent), ctx(f.agentCtx));
  await fire("model_call_ended", withKey(f.modelCallEndedEvent), ctx(f.agentCtx));
  await fire("llm_output", withKey(f.llmOutputEvent), ctx(f.agentCtx));

  await fire("before_tool_call", withKey(f.beforeToolCallEvent), ctx(f.toolCtx));
  await fire("after_tool_call", withKey(f.afterToolCallEvent), ctx(f.toolCtx));
  await fire("tool_result_persist", withKey(f.toolResultPersistEvent), ctx(f.toolCtx));

  if (opts.includeToolError) {
    await fire("before_tool_call", withKey({ ...f.beforeToolCallEvent, toolName: "exec" }), ctx(f.toolCtx));
    await fire("after_tool_call", withKey(f.afterToolCallErrorEvent), ctx({ ...f.toolCtx, toolName: "exec" }));
  }

  if (opts.includeCompaction) {
    // New names on modern hosts, legacy aliases on old ones.
    await fire("before_compaction", withKey(f.beforeCompactionEvent), ctx(f.agentCtx));
    await fire("after_compaction", withKey(f.afterCompactionEvent), ctx(f.agentCtx));
    await fire("before_context_prune", withKey(f.beforeCompactionEvent), ctx(f.agentCtx));
    await fire("after_context_prune", withKey(f.afterCompactionEvent), ctx(f.agentCtx));
  }

  await fire("message_sending", withKey(f.messageSendingEvent), ctx(f.messageCtx));
  await fire("message_sent", withKey(f.messageSentEvent), ctx(f.messageCtx));
  await fire("agent_end", withKey(f.agentEndEvent), ctx(f.agentCtx));
  await fire("session_end", withKey(f.sessionEndEvent), ctx(f.sessionCtx));

  return {
    host,
    sessionKey,
    registeredHookNames: host.registeredHookNames(),
    rejected: host.rejected,
    dispatched,
  };
}
