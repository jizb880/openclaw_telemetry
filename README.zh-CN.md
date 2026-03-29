# openclaw_telemetry

面向 [OpenClaw](https://github.com/openclaw) 网关与智能体的 OpenTelemetry 追踪插件。将 **Action（智能体轮次）**、**消息进出**、**Tool 调用** 与 **LLM（提示词、补全、用量）** 记录为相互关联的 Span，并通过 **OTLP/HTTP** 导出；同时可将同一批 Span **追加写入本地 NDJSON 文件**，便于离线查看或接入自有流水线。

仓库：[github.com/jizb880/openclaw_telemetry](https://github.com/jizb880/openclaw_telemetry)

设计参考：[openclaw-observability-plugin](https://github.com/henrikrexed/openclaw-observability-plugin)、[openclaw-telemetry](https://github.com/knostic/openclaw-telemetry)（钩子与 [其 index.ts](https://github.com/knostic/openclaw-telemetry/blob/main/index.ts) 对齐）。

英文说明：[README.md](README.md)

## OpenClaw 兼容性

对照官方 **插件 SDK**（[Plugin SDK Overview](https://docs.openclaw.ai/plugins/sdk-overview)、[Entry points](https://docs.openclaw.ai/plugins/sdk-entrypoints)）：

| 能力 | 说明 |
|------|------|
| `api.on(...)` | 支持 |
| `api.registerService(...)` | 支持 |
| 注册条件 | 仅在 `api.registrationMode` 为 **`"full"`** 或未设置时注册；`setup-only` / `setup-runtime` 下不注册 |

**注意：** 若看不到 Span，请确认网关为完整注册模式并尽量使用较新的 OpenClaw 版本。打包时可选用 `openclaw/plugin-sdk/plugin-entry` 的 `definePluginEntry`。

### 钩子与 Span 对应关系（与 knostic/openclaw-telemetry 一致）

| 钩子 | Span / 行为 |
|------|-------------|
| `message_received` | `openclaw.request`（入站）；在开启 `captureMessages` 时建立会话根上下文 |
| `message_sent` | `openclaw.message.out`（短生命周期） |
| `before_agent_start` | `openclaw.action` |
| `agent_end` | 结束智能体 Span 与请求根 Span；按需写入 LLM 相关属性 |
| `before_tool_call` | 开始 `openclaw.tool.<name>` |
| `after_tool_call` | 结束对应 Tool Span（LIFO 栈） |

## 功能概要

- **`@opentelemetry/sdk-trace-node` + `@opentelemetry/api`**：`NodeTracerProvider` + `BatchSpanProcessor`。
- **双路导出**：OTLP HTTP（`otlpEndpoint`）+ 可选 **本地 NDJSON 文件**（`otelSpanExportPath`），写入内容与 OTLP 侧为同一批已采样 Span。
- **`GlobalTracer`**：`startSpan`、`withContext` / `withContextAsync`。
- **配置**：`config/observability.json` 或环境变量 `OBSERVABILITY_CONFIG`。

## 环境要求

- Node.js ≥ 18  
- OTLP：需可接收 **OTLP/HTTP** 的后端或 Collector。  
- 文件导出：路径需可写；目录未存在时会尝试创建。

## 安装与构建

```bash
npm install
npm run build
```

插件入口：`dist/index.js`（见 `package.json`、`openclaw.plugin.json`）。

## 配置说明

默认读取 **工作目录** 下的 `config/observability.json`。

指定配置文件路径：

```bash
set OBSERVABILITY_CONFIG=D:\path\to\observability.json
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 总开关。 |
| `serviceName` | string | 资源属性 `service.name`。 |
| `otlpEndpoint` | string | OTLP HTTP 追踪上报地址，例如 `http://localhost:4318/v1/traces`。 |
| `otelSpanExportEnabled` | boolean | 为 `true` 时，将导出的 Span 批次**追加**到本地 NDJSON 文件。 |
| `otelSpanExportPath` | string | **目录**（默认 `.` 即当前工作目录），或**以 `.jsonl` 结尾的完整文件路径**。为目录时，默认文件名为 `openclaw-otel-spans.jsonl`。 |
| `captureAction` | boolean | 是否采集 `before_agent_start` / `agent_end`。 |
| `captureMessages` | boolean | 是否采集 `message_received` / `message_sent`。 |
| `captureTool` | boolean | 是否采集 Tool 相关 Span。 |
| `captureLlm` | boolean | 是否在 `agent_end` 等节点写入用量、模型等。 |
| `captureLlmInput` | boolean | 是否在 `before_agent_start` 写入 `gen_ai.prompt`（大文本会截断）。 |
| `captureLlmOutput` | boolean | 是否写入最后一条 assistant 的 `gen_ai.completion`。 |
| `captureToolInput` | boolean | 是否写入工具入参。 |
| `captureToolOutput` | boolean | 是否写入工具出参。 |

**隐私提示：** 提示词、补全与工具载荷可能含敏感信息；生产环境请按需关闭采集项或关闭文件导出。

## 作为 OpenClaw 插件使用

1. 执行 `npm run build`。  
2. 在 OpenClaw 配置中注册本包，加载 `dist/index.js`。  
3. 在网关工作目录放置 `config/observability.json`，或设置 `OBSERVABILITY_CONFIG`。

插件会注册后台 **service**，在停止时关闭 TracerProvider 并刷新 OTLP 与文件导出批次。

## 编程方式接入

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

## Span 命名一览

| Span 名称 | 对应钩子 |
|-----------|----------|
| `openclaw.request` | `message_received` |
| `openclaw.message.out` | `message_sent` |
| `openclaw.action` | `before_agent_start` |
| `openclaw.tool.<name>` | `before_tool_call` → `after_tool_call` |

## 脚本

| 命令 | 说明 |
|------|------|
| `npm run build` | 编译到 `dist/`。 |
| `npm run typecheck` | 仅类型检查。 |

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
