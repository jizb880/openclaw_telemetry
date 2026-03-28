# openclaw-otel-observability

OpenTelemetry tracing for [OpenClaw](https://github.com/openclaw) gateways and agents. It records **Action** (request + agent turn), **Tool** (before/after tool calls), and **LLM** (prompt, completion, token usage) as connected spans and exports them over **OTLP/HTTP** in the standard OpenTelemetry pipeline.

Design references: patterns from [openclaw-observability-plugin](https://github.com/henrikrexed/openclaw-observability-plugin) (session spans, `api.on` hooks) and [openclaw-telemetry](https://github.com/knostic/openclaw-telemetry) (`before_tool_call` / `after_tool_call`).

## OpenClaw compatibility

Verified against the **current plugin SDK documentation** ([Plugin SDK Overview](https://docs.openclaw.ai/plugins/sdk-overview), [Entry points](https://docs.openclaw.ai/plugins/sdk-entrypoints)):

| Surface used | Documented |
|--------------|------------|
| `api.on(hookName, handler, opts?)` | Yes (typed lifecycle hooks; includes `before_tool_call` semantics) |
| `api.registerService(service)` | Yes (background service) |
| Hooks used here | `message_received`, `before_agent_start`, `agent_end`, `before_tool_call`, `after_tool_call` |

This plugin only registers when `api.registrationMode` is **`"full"`** or **undefined** (older hosts). In `setup-only` / `setup-runtime` it no-ops so it matches OpenClaw’s deferred-loading behaviour.

**Caveats:** The upstream repo has had reports of edge cases around hook delivery (e.g. timing or bundling). If spans are missing, confirm your gateway runs with `registrationMode: "full"` and upgrade OpenClaw to the latest release. For packaging, the SDK recommends `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry` (optional refactor).

## Features

- **`@opentelemetry/sdk-node` + `@opentelemetry/api`**: `NodeSDK` with OTLP HTTP trace exporter.
- **`GlobalTracer`**: singleton with `startSpan(name, options?, parentContext?)` and helpers `withContext` / `withContextAsync` for async context propagation.
- **Interceptors** (OpenClaw plugin hooks):
  - **Action**: `message_received` → root span `openclaw.request`; `before_agent_start` → `openclaw.action`; `agent_end` closes spans and clears session state.
  - **Tool**: `before_tool_call` / `after_tool_call` with a per-session LIFO stack so nested tools stay parented correctly; optional input/output attributes.
  - **LLM**: `before_agent_start` (priority 85) adds `gen_ai.prompt` when enabled; `agent_end` adds `gen_ai.*` usage and optional completion text.
- **Configuration**: `config/observability.json` (or `OBSERVABILITY_CONFIG`) with boolean capture flags.

## Requirements

- Node.js ≥ 18
- A collector or backend that accepts **OTLP/HTTP** traces (for example OpenTelemetry Collector on `http://localhost:4318/v1/traces`).

## Install and build

```bash
npm install
npm run build
```

The compiled entry is `dist/index.js` (see `package.json` / `openclaw.plugin.json`).

## Configuration

Default path: **`config/observability.json`** relative to the process current working directory (typically the OpenClaw project root).

Override the path:

```bash
set OBSERVABILITY_CONFIG=D:\path\to\observability.json
```

### Fields

| Field | Type | Description |
|--------|------|-------------|
| `enabled` | boolean | Master switch; when `false`, the plugin does not start the SDK or hooks. |
| `serviceName` | string | `service.name` resource attribute. |
| `otlpEndpoint` | string | Full OTLP traces URL, e.g. `http://localhost:4318/v1/traces`. |
| `captureAction` | boolean | Root + agent spans from message/agent lifecycle. |
| `captureTool` | boolean | Tool spans from `before_tool_call` / `after_tool_call`. |
| `captureLlm` | boolean | Token usage and model on the agent span at `agent_end`. |
| `captureLlmInput` | boolean | `gen_ai.prompt` on `before_agent_start` (large text truncated). |
| `captureLlmOutput` | boolean | `gen_ai.completion` from last assistant message when present. |
| `captureToolInput` | boolean | `openclaw.tool.input` from tool params. |
| `captureToolOutput` | boolean | `openclaw.tool.output` from tool result/output on success. |

**Privacy**: prompts, completions, and tool payloads may contain secrets. Keep capture flags off in production unless your backend is approved for sensitive data.

## Use as an OpenClaw plugin

1. Build this package (`npm run build`).
2. Register the extension in your OpenClaw config so it loads `dist/index.js` (see `package.json` → `openclaw.extensions`).
3. Place or generate `config/observability.json` next to the gateway working directory, or set `OBSERVABILITY_CONFIG`.

The plugin registers a small **service** that starts after config load and **shuts down** the SDK on stop, flushing spans to the OTLP endpoint.

## Programmatic use

You can reuse pieces without the default plugin object:

```typescript
import { GlobalTracer, loadObservabilityConfig, registerInterceptors } from "openclaw-otel-observability";

const config = loadObservabilityConfig();
const tracer = GlobalTracer.getInstance();
tracer.init(config);
registerInterceptors(openClawApi, tracer, config);
```

## Span model (summary)

| Span name | When | Notes |
|-----------|------|--------|
| `openclaw.request` | `message_received` | Server kind; session/channel metadata. |
| `openclaw.action` | `before_agent_start` | Agent/model attributes; LLM fields attached here. |
| `openclaw.tool.<name>` | `before_tool_call` → `after_tool_call` | Input/output per config; duration from `after_tool_call`. |

If `after_tool_call` is missing for a tool (host bug or crash), remaining tool spans are ended with an error status on `agent_end` to avoid leaking open spans.

## OTLP and backends

Spans are exported with `@opentelemetry/exporter-trace-otlp-http`. Point `otlpEndpoint` at your collector or APM ingest URL that supports OTLP over HTTP.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Emit `dist/` from `src/`. |
| `npm run typecheck` | `tsc --noEmit`. |

## License

Apache-2.0
