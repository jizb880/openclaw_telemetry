# openclaw_telemetry

OpenTelemetry tracing for [OpenClaw](https://github.com/openclaw) gateways and agents. It records **Action** (agent turn), **Messages** (in/out), **Tool** (before/after tool calls), and **LLM** (prompt, completion, token usage) as connected spans. Spans are exported to **OTLP/HTTP** and optionally appended as **NDJSON lines** to a local file for offline inspection.

Repository: [github.com/jizb880/openclaw_telemetry](https://github.com/jizb880/openclaw_telemetry)

Design references: [openclaw-observability-plugin](https://github.com/henrikrexed/openclaw-observability-plugin), [openclaw-telemetry](https://github.com/knostic/openclaw-telemetry) (hook parity with [`index.ts`](https://github.com/knostic/openclaw-telemetry/blob/main/index.ts)).

Chinese documentation: [README.zh-CN.md](README.zh-CN.md)

## OpenClaw compatibility

Verified against the **plugin SDK** ([Plugin SDK Overview](https://docs.openclaw.ai/plugins/sdk-overview), [Entry points](https://docs.openclaw.ai/plugins/sdk-entrypoints)):

| Surface used | Documented |
|--------------|------------|
| `api.on(hookName, handler, opts?)` | Yes |
| `api.registerService(service)` | Yes |
| Hooks registered | See table below |

This plugin only registers when `api.registrationMode` is **`"full"`** or **undefined**. In `setup-only` / `setup-runtime` it no-ops.

**Caveats:** If spans are missing, confirm `registrationMode: "full"` and upgrade OpenClaw. Consider `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry` for packaging.

### Hook → span mapping (aligned with knostic/openclaw-telemetry)

| Hook | Span / behaviour |
|------|------------------|
| `message_received` | Span `openclaw.request` (inbound); sets session root trace when `captureMessages` is on |
| `message_sent` | Span `openclaw.message.out` (short-lived) |
| `before_agent_start` | Span `openclaw.action` |
| `agent_end` | Ends agent span + root request span; LLM attributes when enabled |
| `before_tool_call` | Opens `openclaw.tool.<name>` |
| `after_tool_call` | Closes tool span (LIFO stack) |

## Features

- **`@opentelemetry/sdk-trace-node` + `@opentelemetry/api`**: `NodeTracerProvider` with `BatchSpanProcessor`.
- **Dual export**: OTLP HTTP (`otlpEndpoint`) + optional **NDJSON file** (`otelSpanExportPath`) with the same span batches.
- **`GlobalTracer`**: `startSpan`, `withContext` / `withContextAsync`.
- **Config**: `config/observability.json` (or `OBSERVABILITY_CONFIG`).

## Requirements

- Node.js ≥ 18
- For OTLP: a collector or backend that accepts **OTLP/HTTP** traces.
- For file export: writable path (default file name `openclaw-otel-spans.jsonl` under the configured directory).

## Install and build

```bash
npm install
npm run build
```

Entry: `dist/index.js` (see `package.json` / `openclaw.plugin.json`).

## Configuration

Default file: **`config/observability.json`** (relative to the gateway working directory).

Override path:

```bash
set OBSERVABILITY_CONFIG=D:\path\to\observability.json
```

### Fields

| Field | Type | Description |
|--------|------|-------------|
| `enabled` | boolean | Master switch. |
| `serviceName` | string | `service.name` resource attribute. |
| `otlpEndpoint` | string | OTLP HTTP traces URL, e.g. `http://localhost:4318/v1/traces`. |
| `otelSpanExportEnabled` | boolean | When `true`, append exported span batches to a local NDJSON file. |
| `otelSpanExportPath` | string | Directory (default `.`, i.e. current working directory) or a path ending in `.jsonl` for the full file path. |
| `captureAction` | boolean | `before_agent_start` / `agent_end` spans. |
| `captureMessages` | boolean | `message_received` / `message_sent` spans. |
| `captureTool` | boolean | Tool spans. |
| `captureLlm` | boolean | Token usage / model on agent span at `agent_end`. |
| `captureLlmInput` | boolean | `gen_ai.prompt` on `before_agent_start`. |
| `captureLlmOutput` | boolean | `gen_ai.completion` from last assistant message. |
| `captureToolInput` | boolean | Tool params on span. |
| `captureToolOutput` | boolean | Tool result on span. |

**File export details:** Each line is one span JSON (trace id, attributes, timings, resource, etc.). The directory is created if needed. **Privacy:** prompts and payloads may be sensitive; disable capture flags or file export in production if required.

## Use as an OpenClaw plugin

1. `npm run build`
2. Register the plugin so it loads `dist/index.js`.
3. Provide `config/observability.json` or `OBSERVABILITY_CONFIG`.

The plugin registers a **service** that shuts down the tracer provider on stop (flushes OTLP and pending batches to the file exporter).

## Programmatic use

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

## Span model (summary)

| Span name | Hook |
|-----------|------|
| `openclaw.request` | `message_received` |
| `openclaw.message.out` | `message_sent` |
| `openclaw.action` | `before_agent_start` |
| `openclaw.tool.<name>` | `before_tool_call` → `after_tool_call` |

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Emit `dist/`. |
| `npm run typecheck` | `tsc --noEmit`. |

## License

Apache-2.0 — see [LICENSE](LICENSE).
