# OpenClaw Telemetry - 架构文档

## 项目概述

OpenClaw Telemetry 是一个基于 OpenTelemetry 的追踪插件，为 OpenClaw 网关/Agent 提供可观测性能力。它通过拦截器（Interceptor）记录 Agent 动作、消息收发、工具调用和 LLM 交互，生成分布式追踪 Span，支持导出到 OTLP/HTTP 端点和本地 NDJSON 文件。

**核心依赖：**
- `@opentelemetry/api` / `@opentelemetry/sdk-trace-node` — OpenTelemetry 追踪 API 与 SDK
- `@opentelemetry/exporter-trace-otlp-http` — OTLP HTTP 导出器
- `@opentelemetry/resources` / `@opentelemetry/semantic-conventions` — 资源定义与语义约定

---

## 项目结构

```
openclaw_telemetry/
├── config/
│   └── observability.json            # 默认可观测性配置
├── src/
│   ├── config/
│   │   └── observability.ts          # 配置加载与解析
│   ├── exporters/
│   │   └── jsonl-file-span-exporter.ts  # NDJSON 文件导出器
│   ├── interceptors/
│   │   ├── index.ts                  # 拦截器注册入口
│   │   ├── action.ts                 # Agent 动作拦截器
│   │   ├── llm.ts                    # LLM 交互拦截器
│   │   ├── messages.ts               # 消息收发拦截器
│   │   ├── state.ts                  # 会话状态存储
│   │   └── tool.ts                   # 工具调用拦截器
│   ├── util/
│   │   └── attributes.ts            # 属性序列化工具
│   ├── index.ts                      # 插件入口
│   └── tracer.ts                     # 全局 Tracer 单例
├── openclaw.plugin.json              # OpenClaw 插件清单
├── package.json                      # 项目元数据与依赖
├── tsconfig.json                     # TypeScript 编译配置
├── LICENSE                           # Apache 2.0 许可证
├── README.md                         # 英文文档
└── README.zh-CN.md                   # 中文文档
```

---

## 文件说明

### 根目录

| 文件 | 说明 |
|------|------|
| `package.json` | 项目元数据、依赖声明和构建脚本。目标 Node.js 18+，ESM 模块，入口为 `dist/index.js`。包含 `build`（tsc）、`typecheck`、`clean` 脚本。 |
| `tsconfig.json` | TypeScript 编译配置，目标 ES2022，严格模式，`NodeNext` 模块解析，输出到 `dist/` 目录，生成声明文件和 source map。 |
| `openclaw.plugin.json` | OpenClaw 插件清单文件，定义插件 ID、显示名称、描述和入口点，供 OpenClaw 发现和加载插件。 |
| `LICENSE` | Apache License 2.0 许可证全文。 |
| `README.md` | 英文文档，涵盖功能概览、Hook-Span 映射、安装配置、NDJSON 格式示例和编程接口。 |
| `README.zh-CN.md` | 中文翻译文档，结构与英文版一致。 |
| `.gitignore` | 排除 `node_modules/`、`dist/`、日志文件、`.env` 和 `.DS_Store`。 |

### config/

| 文件 | 说明 |
|------|------|
| `observability.json` | 默认配置文件。所有捕获标志默认启用，OTLP 端点为 `http://localhost:4318/v1/traces`，启用 NDJSON 文件导出。可配置是否捕获 Action、Message、Tool、LLM 数据（prompt、completion、token、输入输出）。 |

### src/

| 文件 | 说明 |
|------|------|
| `index.ts` | **插件入口**。定义 OpenClaw 插件对象，加载配置，检查注册模式和启用状态，初始化 `GlobalTracer`，注册所有拦截器，并注册服务用于优雅关闭。对外导出 `GlobalTracer`、配置工具函数和拦截器注册函数。 |
| `tracer.ts` | **全局 Tracer 单例管理器**。封装 OpenTelemetry 的 `NodeTracerProvider`，使用 `BatchSpanProcessor` 管理 OTLP 导出器和可选的 NDJSON 文件导出器。提供 `startSpan()`、`withContext()`、`withContextAsync()` 方法实现异步安全的 Span 创建，以及 `shutdown()` 进行优雅资源清理。 |

### src/config/

| 文件 | 说明 |
|------|------|
| `observability.ts` | **配置管理模块**。定义 `ObservabilityConfig` 接口（14 个布尔/字符串字段）。导出 `parseObservabilityConfig()`（合并 JSON 与默认值）、`loadObservabilityConfig()`（从文件或 `OBSERVABILITY_CONFIG` 环境变量加载）、`resolveOtelSpanExportFilePath()`（解析 NDJSON 导出路径）。 |

### src/exporters/

| 文件 | 说明 |
|------|------|
| `jsonl-file-span-exporter.ts` | **自定义 SpanExporter 实现**。将 Span 以 NDJSON 格式（每行一个 JSON 对象）追加写入本地文件。内部工具函数包括 `hrToNanos()`（高精度时间转纳秒）、`serializeAttributes()`（属性序列化）和 `spanToJsonLine()`（Span 转 JSON）。自动创建所需目录，适用于离线检查和日志聚合管道。 |

### src/interceptors/

| 文件 | 说明 |
|------|------|
| `index.ts` | **编排模块**。导出类型定义（`OpenClawPluginApi`、`PluginRegistrationMode`）和主函数 `registerInterceptors()`，该函数按顺序注册四类拦截器（messages → actions → tools → LLM）。同时重导出各子模块的公开函数。 |
| `action.ts` | **Agent 动作拦截器**。注册 `before_agent_start`（优先级 90）和 `agent_end`（优先级 -100）钩子。启动时创建 `openclaw.action` Span 并附加会话、Agent ID、模型等属性；结束时用 LLM 数据、成功标志、耗时、错误信息丰富 Span 并关闭。处理孤立的工具 Span。 |
| `llm.ts` | **LLM 交互拦截器**。`enrichAgentSpanForLlm()` 从 `agent_end` 事件消息中提取 token 用量、模型和 completion 信息；`registerLlmHooks()` 注册 `before_agent_start` 钩子（优先级 85）捕获 `gen_ai.prompt` 属性。兼容多种 token 字段命名（input/inputTokens/input_tokens）。 |
| `messages.ts` | **消息收发拦截器**。注册 `message_received`（优先级 100）和 `message_sent`（优先级 50）钩子。`message_received` 创建根 Span `openclaw.request`，附加会话上下文（频道、发送者、内容长度）；`message_sent` 创建短生命周期的 `openclaw.message.out` Span。两者共同建立消息流的追踪上下文层级。 |
| `state.ts` | **有状态上下文存储**。定义两个 Map：`sessionState`（会话键 → `SessionTraceState`，包含根/Agent Span 及上下文）和 `toolStacks`（会话键 → 工具 Span 的 LIFO 栈）。为 `before_tool_call` 和 `after_tool_call` 钩子的异步安全配对提供支撑。 |
| `tool.ts` | **工具调用拦截器**。注册 `before_tool_call`（优先级 50）和 `after_tool_call`（优先级 -50）钩子。调用前创建 `openclaw.tool.<name>` Span 并压入 LIFO 栈；调用后从栈弹出，记录耗时、错误、输出属性并关闭 Span。通过配置标志控制是否捕获工具输入/输出。 |

### src/util/

| 文件 | 说明 |
|------|------|
| `attributes.ts` | **属性序列化工具**。提供 `jsonAttr()` 和 `textAttr()` 函数，将值截断至 8,000 字符（OTel 限制），超出部分追加 "…"。`jsonAttr()` 使用 `JSON.stringify()` 并带有 `String()` 降级。 |

---

## 拦截器协作机制

四类拦截器通过优先级编排，构建出**层级化的 Span 树**：

```
openclaw.request (根 Span)          ← messages.ts: message_received (优先级 100)
└── openclaw.action (Agent Span)    ← action.ts: before_agent_start (优先级 90)
    │                                  llm.ts: 捕获 prompt (优先级 85)
    ├── openclaw.tool.search        ← tool.ts: before_tool_call (优先级 50)
    ├── openclaw.tool.calculate     ← tool.ts: before_tool_call (优先级 50)
    └── openclaw.message.out        ← messages.ts: message_sent (优先级 50)
```

**关键设计：**

1. **优先级驱动的执行顺序** — 高优先级钩子先执行，确保父 Span 在子 Span 之前创建（message:100 → action:90 → llm:85 → tool/message_out:50）；负优先级钩子后执行，确保子 Span 在父 Span 之前关闭（tool:-50 → action:-100）。

2. **异步安全的会话隔离** — `state.ts` 中的 Map 以 session key 为键，支持并发会话互不干扰。工具调用使用 LIFO 栈处理嵌套/顺序调用，无需显式传递 Span 上下文。

3. **配置驱动的细粒度控制** — 每类拦截器可通过布尔标志独立启用/禁用（`captureAction`、`captureMessages`、`captureTool`、`captureLlm`），支持按需调节隐私和性能。

4. **双通道导出** — Span 同时发送到 OTLP/HTTP 端点（用于 Jaeger/Grafana 等后端）和本地 NDJSON 文件（用于离线分析），两者均通过 `BatchSpanProcessor` 批量处理。
