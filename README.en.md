# openclaw_telemetry

Native OTLP tracing for [OpenClaw](https://github.com/openclaw) gateways and agents. It records **every key hook** across the OpenClaw plugin lifecycle as connected spans: session start/end, the input gate, LLM context and output, provider calls (sanitized TTFB / streamed-byte telemetry), tool before/after/persist, inbound/outbound messages, and context compaction. Spans are exported over **OTLP/HTTP** and can optionally be appended to a local **NDJSON file** (standard OTLP/JSON) for offline inspection.

> **Zero runtime dependencies.** The entire OTLP data plane (spans, context propagation, batching, OTLP/JSON serialization, HTTP/file export) is [implemented natively](src/otel/) in this repo with **no `@opentelemetry/*` packages** — only Node.js ≥ 18 built-ins. Output is **byte-compatible** with the official SDK (see [section 9](#9-native-otlp-implementation)).

> Language: [中文](README.md) · **English (this document)**

Repository: [github.com/jizb880/openclaw_telemetry](https://github.com/jizb880/openclaw_telemetry) ｜ Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 1. Hook coverage overview

The table below lists all **17 semantic hooks** (15 span types) this plugin captures, which span each produces, whether it needs authorization, and the "requested field → real host field" mapping. **This table is derived from the single source of truth [`test/harness/coverage.ts`](test/harness/coverage.ts); the E2E suite asserts every row, and the samples in [`samples/coverage.json`](samples/coverage.json) stay in sync.**

| Hook | Span | Auth¹ | Min host | Legacy alias | Notes |
|------|------|:---:|:---:|------|------|
| `session_start` | `openclaw.session.start` | | | | Session opens |
| `message_received` | `openclaw.request` | | | | Inbound message, roots the session trace |
| `before_agent_run` | `openclaw.agent.run` | ✅ | 2026.7 | `before_agent_start` | Input gate (blockable) |
| `llm_input` | `openclaw.llm.input` | ✅ | | | Full context before the LLM (read-only) |
| `model_call_started` | `openclaw.model_call` | | | | Provider call start (sanitized) |
| `model_call_ended` | `openclaw.model_call` | | | | TTFB, streamed bytes, duration (sanitized) |
| `llm_output` | `openclaw.llm.output` | ✅ | | | Host-aggregated full reply + usage |
| `before_tool_call` | `openclaw.tool.<name>` | | | | Tool pre-call interception |
| `after_tool_call` | `openclaw.tool.<name>` | | | | Tool post-call observation |
| `tool_result_persist` | `openclaw.tool.result_persist` | | 2026.7 | | Rewrite before persisting (**must be sync**) |
| `before_compaction` | `openclaw.compaction.before` | | | `before_context_prune` | Before context compaction |
| `after_compaction` | `openclaw.compaction.after` | | | `after_context_prune` | After context compaction |
| `message_sending` | `openclaw.message.sending` | | | | Outbound send hook (rewrite/cancel) |
| `message_sent` | `openclaw.message.out` | | | | Outbound sent |
| `before_agent_start` | `openclaw.action` | | | | Agent turn start (legacy compat) |
| `agent_end` | `openclaw.action` | ✅ | | | Turn end, writes usage/model |
| `session_end` | `openclaw.session.end` | | | | Session teardown |

¹ **Auth**: conversation-class hooks in the host's `CONVERSATION_HOOK_NAMES`. Non-bundled plugins must set `plugins.entries.<id>.hooks.allowConversationAccess = true`, otherwise the host blocks registration and these are **not captured by default**. See [section 5](#5-backward-compatibility--authorization).

### Field mapping (requested field → real host field)

Some of the field names you originally requested differ from the host event's actual fields. The plugin maps them and lands them on span attributes:

| Hook | Requested | Real host field | Span attribute |
|------|------|------|------|
| `before_agent_run` | `content` | `prompt` | `openclaw.agent_run.content` |
| | `historyCount` | `messages` (`.length`) | `openclaw.agent_run.history_count` |
| `llm_input` | `content` | `prompt` | `openclaw.llm.content` |
| | `historyCount` | `historyMessages` (`.length`) | `openclaw.llm.history_count` |
| | `observeOnly:true` | (no host field; read-only by contract) | `openclaw.llm.observe_only=true` |
| `llm_output` | `content` | `assistantTexts` (`join('')`) | `openclaw.llm.content` |
| `before_tool_call` | `paramsText` | `params` (`JSON.stringify`) | `openclaw.tool.input` |
| `after_tool_call` | `resultChars` | `result` (serialized length) | `openclaw.tool.result_chars` |
| `tool_result_persist` | `result` | `message.content` (no separate field) | `openclaw.tool.persist_result` |

---

## 2. Quick start

```bash
npm install
npm run build      # produces dist/index.js (plugin entry)
```

Place `config/observability.json` in the gateway working directory (see [section 4](#4-configuration)), or point `OBSERVABILITY_CONFIG` at an absolute path. The plugin only registers when `api.registrationMode` is `"full"` or unset.

**To capture conversation hooks** (`before_agent_run` / `llm_input` / `llm_output` / `agent_end`), also grant conversation access in the OpenClaw main config:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-otel-observability": {
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

---

## 3. Verifying "all hooks capture data on this host version"

Two complementary verification paths, plus a completeness self-check proving both cover every hook. Set up the environment with 3.0, then pick 3.1 (automated, no gateway needed) or 3.2 (real gateway, eyeball confirmation).

### 3.0 Prepare the environment (shared by both paths)

**Prerequisites**

| Requirement | Needed | Verified here |
|------|------|------|
| Node.js | >= 18 (`engines` in `package.json`) | **v24.18.0 passing** |
| npm | ships with Node | 11.16.0 |
| Runtime dependencies | **none** (`dependencies` is empty; Node built-ins only) | — |

Check versions first:

```bash
node -v      # expect v18 or newer, e.g. v24.18.0
npm -v
```

**Install and build**

```bash
git clone <this-repo> && cd openclaw_telemetry
npm install          # installs only typescript / @types/node; no runtime deps
npm run build        # produces dist/index.js (plugin entry)
```

`npm install` pulls no runtime dependency — the OTLP data plane is the native implementation in `src/otel/` (see [section 9](#9-native-otlp-implementation)).

### 3.1 End-to-end test (recommended, automated, reproducible)

**This path needs no real gateway and no collector — one command runs everything.**

```bash
npm run verify
```

It runs three steps in order — typecheck → all tests (**57 cases**: 25 hook E2E + 27 native OTLP + 5 zero-external-dependency guards) → regenerate samples. Real output ends like:

```text
> tsc --noEmit -p tsconfig.json                  # (1) typecheck: no output means pass
> node --test ".test-build/test/**/*.test.js"    # (2) all tests
...
ℹ tests 57
ℹ pass 57
ℹ fail 0
> node .test-build/scripts/generate-samples.js   # (3) regenerate samples
Wrote 17 hook sample spans, full-turn NDJSON (1 lines), and coverage.json to samples/
```

**How to read the result: `pass 57 / fail 0` plus the final line writing 17 hook samples means every hook captures data on this host version.** Any failing step aborts the chain and `npm run verify` fails.

For tests only, run `npm test`; the tail should read:

```text
ℹ tests 57
ℹ suites 11
ℹ pass 57
ℹ fail 0
```

What the tests do:

- **Per-hook assertions**: a built-in mock host constructs events with the **exact field names of the real host**, drives the full plugin chain, reads back the exported NDJSON spans, and checks every required attribute declared in [`coverage.ts`](test/harness/coverage.ts) exists and is non-empty.
- **Completeness self-check**: the hook set in `coverage.ts` is cross-checked against the authoritative list exported from the real host, [`test/fixtures/host-hook-names.json`](test/fixtures/host-hook-names.json). If the host adds a hook the manifest doesn't cover, the test **fails**. This is the completeness mechanism.
- **Backward compatibility**: simulates a legacy host (no `before_agent_run`, `*_context_prune` aliases), asserts no throw and data still captured, and asserts no double-counting on a modern host.
- **Authorization gate**: asserts conversation hooks are blocked without `allowConversationAccess` and non-conversation hooks are unaffected.
- **Sync contract**: asserts the `tool_result_persist` handler is synchronous (a Promise return is ignored and warned by the host).
- **Native OTLP implementation** ([`test/otel.test.ts`](test/otel.test.ts), 27 cases): OTLP/JSON compliance (uint64 nanosecond timestamps encoded as strings, int vs double `AnyValue`, root spans omitting `parentSpanId`, status carrying a message only when set), span lifecycle (mutations rejected after `end()`, trace-id inheritance), context propagation across `await`, batching (splitting, queue-cap dropping, flush on shutdown), and OTLP/HTTP payload + content-type verified against **a real HTTP server**.

> After a host upgrade, resync the authoritative list: `npm run sync:host-hooks` (re-exports `test/fixtures/host-hook-names.json` from the installed OpenClaw), then `npm run verify` surfaces any new hook.

### 3.2 Manual test (real gateway, eyeball confirmation)

The E2E path uses a mock host to guarantee **logic and field mapping** are complete and reproducible; the manual path confirms on a **real host** that hooks actually fire and authorization actually takes effect. Both consume the same `coverage.json`, so the completeness bar is identical. Six steps:

**Step 1 · Build the plugin**

```bash
npm run build          # produces dist/index.js
```

**Step 2 · Write the config (NDJSON-only, no collector needed)**

Put `config/observability.json` in the gateway working directory. For local eyeball verification, turn off OTLP HTTP and write NDJSON only:

```jsonc
{
  "enabled": true,
  "otlpEnabled": false,                    // skip OTLP HTTP export; no collector required
  "otelSpanExportEnabled": true,           // write spans to a local NDJSON file
  "otelSpanExportPath": "./telemetry-out"   // writable dir; default file openclaw-otel-spans.jsonl
}
```

Omitted keys fall back to defaults (all `capture*` flags default to on). Full field list in [section 4](#4-configuration).

**Step 3 · Grant conversation access (required for `llm_input` / `llm_output` / `before_agent_run`)**

Grant the plugin permission in the OpenClaw main config, or the host blocks these conversation hooks outright:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-otel-observability": { "hooks": { "allowConversationAccess": true } }
    }
  }
}
```

**Step 4 · Load the plugin and run one full real turn**

Load `dist/index.js` in OpenClaw, then complete **one full real turn** that triggers **at least one tool call**. To cover the compaction hooks, extend the session until context compaction fires.

**Step 5 · Inspect the exported spans and check completeness**

The output file is `./telemetry-out/openclaw-otel-spans.jsonl` (standard OTLP/JSON, one `ExportTraceServiceRequest` per line). The repo ships a checker script — **pure Node, no `jq` and no other external command**:

```bash
npm run inspect                                  # defaults to ./telemetry-out/openclaw-otel-spans.jsonl
npm run inspect -- /path/to/spans.jsonl           # explicit file
npm run inspect -- /path/to/spans.jsonl --json    # machine-readable, for CI
```

**Real output** for one complete turn (15 spans; tool span names vary with the tool you actually call):

```text
file    telemetry-out/openclaw-otel-spans.jsonl
batches 1
spans   15 distinct

  ✓ openclaw.action                 ✓ openclaw.message.out
  ✓ openclaw.agent.run              ✓ openclaw.message.sending
  ✓ openclaw.compaction.after       ✓ openclaw.model_call
  ✓ openclaw.compaction.before      ✓ openclaw.request
  ✓ openclaw.llm.input              ✓ openclaw.session.end
  ✓ openclaw.llm.output             ✓ openclaw.session.start
  ✓ openclaw.tool.exec              ✓ openclaw.tool.result_persist
  ✓ openclaw.tool.web_search

✓ ALL COVERED — every expected hook span is present (14 expected)
```

> Columns above are for readability; the script prints one span per line, alphabetically.

**Step 6 · Read the result**

**`✓ ALL COVERED` with exit code 0 means your manual test covered every triggerable hook on this host version.** Otherwise the script names what is missing and exits 1:

```text
✗ MISSING 4 span(s):
  - openclaw.compaction.after
  - openclaw.compaction.before
  - openclaw.llm.input
  - openclaw.llm.output
```

Use the table to locate the cause:

| Missing span | Usual cause | Fix |
|------|------|------|
| `openclaw.llm.input` / `openclaw.llm.output` / `openclaw.agent.run` | conversation access not granted | do step 3 |
| `openclaw.tool.*` / `openclaw.tool.result_persist` | no tool call this turn; `tool_result_persist` also needs host >= 2026.7 | make the turn call a tool |
| `openclaw.compaction.*` | session never reached context compaction | keep the session going |
| `export file not found` | plugin not loaded, `enabled=false`, or output dir not writable | check the `[otel]` lines in the gateway log |

> Tool spans are dynamic `openclaw.tool.<name>`. The script accounts for this: any captured `openclaw.tool.*` satisfies the tool path, so calling a tool other than `web_search` is never falsely reported as missing.

---

## 4. Configuration

Reads `config/observability.json` from cwd by default; `OBSERVABILITY_CONFIG` overrides with an absolute path. Unknown keys are ignored; missing keys fall back to defaults.

| Field | Type | Default | Description |
|------|------|------|------|
| `enabled` | boolean | `true` | Master switch. |
| `serviceName` | string | `openclaw` | `service.name` resource attribute. |
| `otlpEndpoint` | string | `http://localhost:4318/v1/traces` | OTLP HTTP traces URL. |
| `otlpEnabled` | boolean | `true` | `false` skips the OTLP exporter entirely (NDJSON-only). |
| `otelSpanExportEnabled` | boolean | `true` | Append span batches to a local NDJSON file. |
| `otelSpanExportPath` | string | `.` | Directory (default file `openclaw-otel-spans.jsonl`) or a `.jsonl` full path. |
| `captureAction` | boolean | `true` | `before_agent_start` / `agent_end`. |
| `captureAgentRun` | boolean | `true` | `before_agent_run` (with legacy `before_agent_start` fallback). |
| `captureMessages` | boolean | `true` | `message_received` / `message_sent`. |
| `captureMessageSending` | boolean | `true` | `message_sending`. |
| `captureTool` | boolean | `true` | `before_tool_call` / `after_tool_call`. |
| `captureToolResultPersist` | boolean | `true` | `tool_result_persist`. |
| `captureModelCall` | boolean | `true` | `model_call_started` / `model_call_ended`. |
| `captureSession` | boolean | `true` | `session_start` / `session_end`. |
| `captureCompaction` | boolean | `true` | `before_compaction` / `after_compaction` (+ legacy aliases). |
| `captureLlm` | boolean | `true` | LLM capture master switch. |
| `captureLlmInput` | boolean | `true` | `llm_input` and `gen_ai.prompt`. |
| `captureLlmOutput` | boolean | `true` | `llm_output` and usage. |
| `captureToolInput` | boolean | `true` | Tool params. |
| `captureToolOutput` | boolean | `true` | Tool result and persist payload. |

**Privacy:** prompts, tool payloads, and persisted messages may be sensitive. Disable the relevant `capture*` flags or file export in production. Attribute values are truncated to 8000 chars.

---

## 5. Backward compatibility & authorization

**The compat strategy relies on the host's observed `registerTypedHook` behavior: unknown hook names are silently ignored (warn only), never thrown.** So the plugin registers both new and legacy names; on any host only the recognized set wires up:

- **Input gate**: on modern hosts `before_agent_start` opens the `openclaw.agent.run` span and `before_agent_run` enriches it with `systemPrompt` and the authoritative `historyCount` before it closes; on legacy hosts without `before_agent_run`, `agent_end` closes it as a fallback, and `openclaw.agent_run.source` records the origin.
- **Compaction**: registers both `before_compaction`/`after_compaction` and legacy `before_context_prune`/`after_context_prune`. The two sets are mutually exclusive per host, so no double-counting (asserted by a dedicated test).
- **`tool_result_persist`**: only present on host ≥ 2026.7; on older hosts its registration is ignored and other captures are unaffected. The handler **must be synchronous** — a Promise return is ignored and warned by the host, enforced by a test.

> All field definitions verified against OpenClaw **2026.7.1-2**. That host has **no** `*_context_prune` aliases (no matches in the package); they're kept only for older versions.

---

## 6. Sample data

The [`samples/`](samples/) directory commits real capture output produced by `npm run samples`:

| File | Content |
|------|------|
| [`samples/full-turn.otlp.ndjson`](samples/full-turn.otlp.ndjson) | Every span from a full turn, standard OTLP/JSON NDJSON, one `ExportTraceServiceRequest` per line |
| [`samples/spans/<hook>.json`](samples/spans/) | **One sample per hook**, with field-mapping notes and the actual span attributes |
| [`samples/coverage.json`](samples/coverage.json) | Machine-readable coverage manifest consumed by the manual completeness check |

Each NDJSON line is a standard OTLP/JSON `ExportTraceServiceRequest` (`resourceSpans` → `scopeSpans` → `spans`), identical to the OTLP HTTP payload, directly consumable by the OTel Collector's `otlpjsonfile` receiver. `kind` and `status.code` are OTLP proto enums (`kind`: 1=INTERNAL, 2=SERVER, 3=CLIENT; `status.code`: 1=OK, 2=ERROR).

---

## 7. Programmatic use

```typescript
import {
  GlobalTracer,
  loadObservabilityConfig,
  registerInterceptors,
  resolveOtelSpanExportFilePath,
} from "openclaw-otel-observability";

const config = loadObservabilityConfig();
const tracer = GlobalTracer.getInstance();
tracer.init(config, resolveOtelSpanExportFilePath, {
  onError: (err) => console.warn("[otel] export failed:", err),
});
registerInterceptors(openClawApi, tracer, config);
```

The plugin registers a background service that shuts down the TracerProvider on stop (flushing OTLP and file batches). `GlobalTracer` also exposes `forceFlush()`. The third `onError` argument receives export failures (unreachable network, disk write errors) — **failures are reported, never thrown**, so telemetry problems cannot break the host.

The native OTLP building blocks are exported too, for standalone use (e.g. your own export pipeline):

```typescript
import {
  BatchSpanProcessor,
  OtlpJsonFileSpanExporter,
  TracerProvider,
  serializeSpansToOtlpJson,
} from "openclaw-otel-observability";
```

---

## 8. Scripts

| Command | Description |
|------|------|
| `npm run build` | Compile the plugin to `dist/`. |
| `npm run typecheck` | Type-check only. |
| `npm test` | Compile and run all tests (57 cases). |
| `npm run samples` | Regenerate the samples under `samples/`. |
| `npm run inspect` | Check hook coverage of an exported NDJSON file (pure Node, no external commands). |
| `npm run verify` | **typecheck + test + samples** in one command. |
| `npm run sync:host-hooks` | Re-export the authoritative hook list from the installed host. |
| `npm run clean` | Remove `dist/` and `.test-build/`. |

---

## 9. Native OTLP implementation

This plugin has **no `@opentelemetry/*` dependencies** (`dependencies` is empty; only `typescript` / `@types/node` remain as dev dependencies). The whole OTLP data plane lives in [`src/otel/`](src/otel/) and uses only Node.js ≥ 18 built-ins (`node:crypto` for IDs, `node:async_hooks` for context, global `fetch` for export).

| File | Responsibility | Replaces |
|------|------|------|
| [`primitives.ts`](src/otel/primitives.ts) | `SpanKind`/`SpanStatusCode` enums (proto-matching values), trace/span ID generation, nanosecond time math | `@opentelemetry/api` |
| [`context.ts`](src/otel/context.ts) | `context.active()` / `context.with()` / `trace.setSpan()`, immutable contexts over `AsyncLocalStorage` | `@opentelemetry/api`, `context-async-hooks` |
| [`span.ts`](src/otel/span.ts) | Span implementation (attributes, status, events, exceptions, frozen after `end()`) and `ReadableSpan` | `sdk-trace-base` |
| [`otlp-json.ts`](src/otel/otlp-json.ts) | Builds a standard `ExportTraceServiceRequest`, including `AnyValue` typing | `otlp-transformer` |
| [`exporters.ts`](src/otel/exporters.ts) | NDJSON file exporter + OTLP/HTTP exporter (`fetch` with timeout abort) | `exporter-trace-otlp-http` |
| [`batch-processor.ts`](src/otel/batch-processor.ts) | Batch buffering, scheduled flush (`unref`'d timer), queue cap, serialized export | `sdk-trace-base` |
| [`provider.ts`](src/otel/provider.ts) | Owns processors, issues tracers, `forceFlush` / `shutdown` | `sdk-trace-node` |

**Why the output stays portable**: serialization follows the OTLP/JSON mapping strictly — uint64 `startTimeUnixNano`/`endTimeUnixNano` are encoded as **strings**, integers use `intValue` and non-integers `doubleValue`, root spans omit `parentSpanId`, and `droppedAttributesCount` / `events` / `links` are preserved. The result is consumable by Jaeger, Grafana, and the OTel Collector (including the `otlpjsonfile` receiver).

**How compatibility was verified**: the samples generated by the official SDK before the refactor were kept as a baseline, then regenerated afterwards and compared **structurally** (line-diffed after normalizing random IDs and timestamps). The only difference was a single wall-clock reading (`openclaw.request.duration_ms`, which varies every run). 27 targeted cases additionally assert encoding compliance and HTTP export.

**Design note**: the provider is **not registered globally** (no OTel `register()` call), so it cannot clash with a host-installed OTel SDK; this plugin only exports spans it created itself. To share trace context with the host, pass your own tracer to `registerInterceptors`.

---

## Requirements

- Node.js ≥ 18 (needs built-in `fetch`; no other runtime dependencies)
- OTLP export: an OTLP/HTTP collector or backend (set `otlpEnabled=false` to skip)
- File export: a writable path; the directory is created if missing

## License

Apache-2.0 — see [LICENSE](LICENSE).
