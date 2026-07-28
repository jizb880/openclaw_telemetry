# openclaw_telemetry

OpenTelemetry tracing for [OpenClaw](https://github.com/openclaw) gateways and agents. It records **every key hook** across the OpenClaw plugin lifecycle as connected spans: session start/end, the input gate, LLM context and output, provider calls (sanitized TTFB / streamed-byte telemetry), tool before/after/persist, inbound/outbound messages, and context compaction. Spans are exported over **OTLP/HTTP** and can optionally be appended to a local **NDJSON file** (standard OTLP/JSON) for offline inspection.

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

Two complementary verification paths, plus a completeness self-check that proves both paths cover every hook.

### 3.1 End-to-end test (recommended, automated, reproducible)

```bash
npm run verify
```

Runs typecheck → E2E tests (25 cases) → regenerate samples. The tests:

- **Per-hook assertions**: a built-in mock host constructs events with the **exact field names of the real host**, drives the full plugin chain, reads back the exported NDJSON spans, and checks every required attribute declared in [`coverage.ts`](test/harness/coverage.ts) exists and is non-empty.
- **Completeness self-check**: the hook set in `coverage.ts` is cross-checked against the authoritative list exported from the real host, [`test/fixtures/host-hook-names.json`](test/fixtures/host-hook-names.json). If the host adds a hook the manifest doesn't cover, the test **fails**. This is the completeness mechanism.
- **Backward compatibility**: simulates a legacy host (no `before_agent_run`, `*_context_prune` aliases), asserts no throw and data still captured, and asserts no double-counting on a modern host.
- **Authorization gate**: asserts conversation hooks are blocked without `allowConversationAccess` and non-conversation hooks are unaffected.
- **Sync contract**: asserts the `tool_result_persist` handler is synchronous (a Promise return is ignored and warned by the host).

Expected tail: `tests 25 / pass 25 / fail 0`.

> After a host upgrade, resync the authoritative list: `npm run sync:host-hooks`, then `npm run verify` surfaces any new hook.

### 3.2 Manual test (real gateway, eyeball confirmation)

1. Build and register: `npm run build`, load `dist/index.js` in OpenClaw.
2. Skip the collector via NDJSON-only mode: set `otlpEnabled=false`, `otelSpanExportEnabled=true`, and a writable `otelSpanExportPath`.
3. For conversation hooks, enable `allowConversationAccess=true` (section 2).
4. Run a **full real turn** with at least one tool call; to cover compaction hooks, extend the session until context compaction triggers.
5. Inspect `openclaw-otel-spans.jsonl`:

   ```bash
   jq '.resourceSpans[].scopeSpans[].spans[].name' openclaw-otel-spans.jsonl | sort -u
   ```

6. **Cross-check against the span list in [section 1](#1-hook-coverage-overview).** To confirm manual completeness, list spans that should appear but are missing:

   ```bash
   comm -13 \
     <(jq -r '.resourceSpans[].scopeSpans[].spans[].name' openclaw-otel-spans.jsonl | sort -u) \
     <(jq -r '.hooks[].span' samples/coverage.json | sort -u)
   ```

   Empty output means **your manual test covered every triggerable hook on this host version**. Any output means that hook wasn't triggered (no conversation auth, host too old, or no tool/compaction this turn).

   > Note: tool spans are dynamic `openclaw.tool.<name>`; `coverage.json` uses `openclaw.tool.web_search` as a representative. If your actual tool name differs it may false-positive as "missing" — as long as **any** `openclaw.tool.*` (plus `openclaw.tool.result_persist`) is present, the tool path is covered.

> Relationship: the E2E path uses a mock host to guarantee **logic and field mapping** are complete and reproducible; the manual path confirms on a **real host** that hooks actually fire and authorization actually takes effect. Both consume the same `coverage.json`, so the completeness bar is identical.

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
tracer.init(config, resolveOtelSpanExportFilePath);
registerInterceptors(openClawApi, tracer, config);
```

The plugin registers a background service that shuts down the TracerProvider on stop (flushing OTLP and file batches). `GlobalTracer` also exposes `forceFlush()`.

---

## 8. Scripts

| Command | Description |
|------|------|
| `npm run build` | Compile the plugin to `dist/`. |
| `npm run typecheck` | Type-check only. |
| `npm test` | Compile and run the E2E suite (25 cases). |
| `npm run samples` | Regenerate the samples under `samples/`. |
| `npm run verify` | **typecheck + test + samples** in one command. |
| `npm run sync:host-hooks` | Re-export the authoritative hook list from the installed host. |
| `npm run clean` | Remove `dist/` and `.test-build/`. |

## Requirements

- Node.js ≥ 18
- OTLP export: an OTLP/HTTP collector or backend (set `otlpEnabled=false` to skip)
- File export: a writable path; the directory is created if missing

## License

Apache-2.0 — see [LICENSE](LICENSE).
