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
├── samples/                          # 采集数据样例（由 npm run samples 生成）
│   ├── full-turn.otlp.ndjson         # 一整轮对话的全部 Span（OTLP/JSON NDJSON）
│   ├── coverage.json                 # 机器可读的 hook 覆盖清单
│   └── spans/<hook>.json             # 每个 hook 一份样例 Span
├── scripts/
│   ├── generate-samples.ts           # 生成 samples/ 语料
│   └── sync-host-hooks.ts            # 从本机宿主导出权威 hook 列表
├── src/
│   ├── config/
│   │   └── observability.ts          # 配置加载与解析
│   ├── exporters/
│   │   └── jsonl-file-span-exporter.ts  # NDJSON 文件导出器
│   ├── interceptors/
│   │   ├── index.ts                  # 拦截器注册入口
│   │   ├── action.ts                 # Agent 轮次（before_agent_start / agent_end）
│   │   ├── agent-run.ts              # 输入门禁（before_agent_run + 旧版兜底）
│   │   ├── compaction.ts             # 上下文压缩（含 *_context_prune 旧别名）
│   │   ├── llm.ts                    # llm_input / llm_output
│   │   ├── messages.ts               # 消息收发（含 message_sending）
│   │   ├── model-call.ts             # Provider 调用脱敏遥测
│   │   ├── session.ts                # 会话生命周期
│   │   ├── state.ts                  # 会话状态存储
│   │   └── tool.ts                   # 工具调用 + tool_result_persist
│   ├── util/
│   │   └── attributes.ts            # 属性序列化工具
│   ├── index.ts                      # 插件入口
│   └── tracer.ts                     # 全局 Tracer 单例
├── test/
│   ├── e2e.test.ts                   # 端到端测试（25 用例）
│   ├── fixtures/host-hook-names.json # 从宿主导出的权威 hook 名单
│   └── harness/
│       ├── coverage.ts               # hook 覆盖清单（唯一事实源）
│       ├── fixtures.ts               # 与宿主字段一致的事件样本
│       ├── mock-host.ts              # Mock 宿主（复刻注册与授权行为）
│       └── scenario.ts               # 完整轮次驱动器 + Span 读回
├── openclaw.plugin.json              # OpenClaw 插件清单
├── package.json                      # 项目元数据与依赖
├── tsconfig.json                     # TypeScript 编译配置
├── tsconfig.test.json                # 测试/脚本编译配置
├── LICENSE                           # Apache 2.0 许可证
├── README.md                         # 中文主文档
├── README.en.md                      # 英文文档
└── README.zh-CN.md                   # 旧链接跳转
```

---

## 文件说明

### 根目录

| 文件 | 说明 |
|------|------|
| `package.json` | 项目元数据、依赖声明和构建脚本。目标 Node.js 18+，ESM 模块，入口为 `dist/index.js`。包含 `build`、`typecheck`、`test`、`samples`、`verify`、`sync:host-hooks`、`clean` 脚本。 |
| `tsconfig.json` | TypeScript 编译配置，目标 ES2022，严格模式，`NodeNext` 模块解析，输出到 `dist/` 目录，生成声明文件和 source map。 |
| `tsconfig.test.json` | 继承主配置，额外纳入 `test/`、`scripts/`，输出到 `.test-build/`，供 `node --test` 运行。 |
| `openclaw.plugin.json` | OpenClaw 插件清单文件，定义插件 ID、显示名称、描述和入口点，供 OpenClaw 发现和加载插件。 |
| `LICENSE` | Apache License 2.0 许可证全文。 |
| `README.md` | **中文主文档**，涵盖 hook 全景、字段映射、配置、手测与端到端验证指南、完备性核对方法。 |
| `README.en.md` | 英文文档，结构与中文版一致。 |
| `README.zh-CN.md` | 旧链接跳转页，指向根 `README.md`。 |
| `.gitignore` | 排除 `node_modules/`、`dist/`、`.test-build/`、日志文件、`.env` 和 `.DS_Store`。 |

### config/

| 文件 | 说明 |
|------|------|
| `observability.json` | 默认配置文件。所有捕获标志默认启用，OTLP 端点为 `http://localhost:4318/v1/traces`，启用 NDJSON 文件导出。可配置是否捕获 Action、Message、Tool、LLM 数据（prompt、completion、token、输入输出）。 |

### src/

| 文件 | 说明 |
|------|------|
| `index.ts` | **插件入口**。定义 OpenClaw 插件对象，加载配置，检查注册模式和启用状态，初始化 `GlobalTracer`，注册所有拦截器，并注册服务用于优雅关闭。对外导出 `GlobalTracer`、配置工具函数和拦截器注册函数。 |
| `tracer.ts` | **全局 Tracer 单例管理器**。封装 OpenTelemetry 的 `NodeTracerProvider`，使用 `BatchSpanProcessor` 管理 OTLP 导出器（可由 `otlpEnabled=false` 完全跳过）和可选的 NDJSON 文件导出器。提供 `startSpan()`、`withContext()`、`withContextAsync()` 实现异步安全的 Span 创建，`forceFlush()` 主动落盘，以及 `shutdown()` 优雅清理。 |

### src/config/

| 文件 | 说明 |
|------|------|
| `observability.ts` | **配置管理模块**。定义 `ObservabilityConfig` 接口（21 个布尔/字符串字段，含 `otlpEnabled` 与各 `capture*` 开关）。导出 `parseObservabilityConfig()`（合并 JSON 与默认值）、`loadObservabilityConfig()`（从文件或 `OBSERVABILITY_CONFIG` 环境变量加载）、`resolveOtelSpanExportFilePath()`（解析 NDJSON 导出路径）。 |

### src/exporters/

| 文件 | 说明 |
|------|------|
| `jsonl-file-span-exporter.ts` | **自定义 SpanExporter 实现**。使用官方 `@opentelemetry/otlp-transformer` 的 `JsonTraceSerializer` 将每个导出批次序列化为标准 **OTLP/JSON** `ExportTraceServiceRequest`，以 NDJSON 形式（每行一个请求 JSON）追加写入本地文件，与 OTLP HTTP 上报载荷完全一致。自动创建所需目录，可直接被 OTel Collector `otlpjsonfile` receiver 等标准工具消费。 |

### src/interceptors/

| 文件 | 说明 |
|------|------|
| `index.ts` | **编排模块**。导出类型定义（`OpenClawPluginApi`、`PluginRegistrationMode`）和主函数 `registerInterceptors()`，依次注册八类拦截器（messages → action → agent-run → tool → llm → model-call → session → compaction）。同时重导出各子模块的公开函数。 |
| `action.ts` | **Agent 轮次拦截器**。注册 `before_agent_start`（优先级 90）和 `agent_end`（优先级 -100）。启动时创建 `openclaw.action` Span 并附加会话、Agent ID、模型属性；结束时写入 LLM 用量、成功标志、耗时、错误并关闭。清理孤立工具 Span 与残留 model-call Span。 |
| `agent-run.ts` | **输入门禁拦截器**。`before_agent_start`（优先级 80）先开启 `openclaw.agent.run` Span；`before_agent_run`（优先级 80）补齐 `systemPrompt` 与权威 `historyCount` 后关闭；`agent_end`（优先级 -90）为缺少 `before_agent_run` 的旧宿主兜底关闭。`openclaw.agent_run.source` 标明数据来源。 |
| `llm.ts` | **LLM 交互拦截器**。`enrichAgentSpanForLlm()` 从 `agent_end` 提取 token 用量与模型；`llm_input`（优先级 60）产出 `openclaw.llm.input`（含 `observe_only` 标记）；`llm_output`（优先级 60）把 `assistantTexts` 聚合为完整回复并写入 `gen_ai.usage.*`。 |
| `messages.ts` | **消息收发拦截器**。`message_received`（优先级 100）创建根 Span `openclaw.request`；`message_sending`（优先级 60）产出 `openclaw.message.sending`（只读，不改写投递）；`message_sent`（优先级 50）产出 `openclaw.message.out`。 |
| `model-call.ts` | **Provider 调用拦截器**。`model_call_started`（优先级 60）以 `runId::callId` 为键开启 `openclaw.model_call`（CLIENT kind）；`model_call_ended`（优先级 -60）配对写入 TTFB、流式字节、耗时、outcome 后关闭。载荷天然脱敏，不含 prompt/response/headers。 |
| `session.ts` | **会话生命周期拦截器**。`session_start`（优先级 100）与 `session_end`（优先级 -100）产出独立 Span（无父级，因其在轮次之外触发），记录 reason、消息数、时长等。 |
| `compaction.ts` | **上下文压缩拦截器**。同时注册 `before_compaction`/`after_compaction` 与旧别名 `before_context_prune`/`after_context_prune`；宿主会静默忽略不认识的名字，且两套名字互斥，故不会重复计数。 |
| `state.ts` | **有状态上下文存储**。`sessionState`（会话键 → 根/Agent/门禁 Span 及上下文）、`toolStacks`（会话键 → 工具 Span 的 LIFO 栈）、`modelCallSpans`（`runId::callId` → 在途 Provider 调用 Span），并提供 `clearSessionArtifacts()`、`clearModelCallsForRun()` 清理函数。 |
| `tool.ts` | **工具调用拦截器**。`before_tool_call`（优先级 50）创建 `openclaw.tool.<name>` Span 并压栈；`after_tool_call`（优先级 -50）弹栈并记录耗时、错误、输出与 `result_chars`；`tool_result_persist`（优先级 50）产出 `openclaw.tool.result_persist`，**处理器为同步**（宿主会忽略 Promise 返回），只观察不改写持久化消息。 |

### src/util/

| 文件 | 说明 |
|------|------|
| `attributes.ts` | **属性序列化工具**。提供 `jsonAttr()` 和 `textAttr()` 函数，将值截断至 8,000 字符（OTel 限制），超出部分追加 "…"。`jsonAttr()` 使用 `JSON.stringify()` 并带有 `String()` 降级。 |

### test/ 与 scripts/

| 文件 | 说明 |
|------|------|
| `test/harness/coverage.ts` | **hook 覆盖清单（唯一事实源）**。声明每个 hook 对应的 Span、必备属性、字段映射、是否需授权、旧版别名。端到端测试据此断言，样例生成器据此渲染 `samples/`。新增 hook 未登记会导致完备性用例失败。 |
| `test/harness/mock-host.ts` | **Mock 宿主**。复刻真实 `registerTypedHook` 的三项行为：未知 hook 名静默忽略、会话类 hook 受 `allowConversationAccess` 门禁、按优先级降序串行执行。另提供 modern / legacy / 无授权三种宿主画像，并在 `tool_result_persist` 返回 Promise 时抛错以守住同步契约。 |
| `test/harness/fixtures.ts` | **事件样本**。字段名全部取自宿主 `hook-types-*.d.ts`（2026.7.1-2），确保测试与生产载荷同形。 |
| `test/harness/scenario.ts` | **完整轮次驱动器**。按真实触发顺序驱动全部 hook，并把导出的 OTLP/JSON NDJSON 解码回 Span 供断言；以 session key 隔离不同场景。 |
| `test/e2e.test.ts` | 端到端测试（25 用例）：注册完备性、逐 hook 数据采集、字段映射、向后兼容、授权门禁、capture 开关。 |
| `test/fixtures/host-hook-names.json` | 从本机宿主导出的权威 hook 名单（40 个 hook、7 个会话类），供无宿主环境（CI）校验完备性。 |
| `scripts/generate-samples.ts` | 生成 `samples/` 语料：整轮 NDJSON、每 hook 一份样例 Span、机器可读覆盖清单。 |
| `scripts/sync-host-hooks.ts` | 从本机安装的 OpenClaw 重新导出权威 hook 名单，用于宿主升级后检测新增 hook。 |

---

## 拦截器协作机制

八类拦截器通过优先级编排，构建出**层级化的 Span 树**：

```
openclaw.session.start                 ← session.ts: session_start (优先级 100，独立 Span)
openclaw.request (根 Span)             ← messages.ts: message_received (优先级 100)
└── openclaw.action (Agent Span)       ← action.ts: before_agent_start (优先级 90)
    ├── openclaw.agent.run             ← agent-run.ts: before_agent_start 开启 / before_agent_run 关闭 (优先级 80)
    ├── openclaw.llm.input             ← llm.ts: llm_input (优先级 60)
    ├── openclaw.model_call            ← model-call.ts: model_call_started → ended (优先级 60 / -60)
    ├── openclaw.llm.output            ← llm.ts: llm_output (优先级 60)
    ├── openclaw.tool.<name>           ← tool.ts: before_tool_call → after_tool_call (优先级 50 / -50)
    ├── openclaw.tool.result_persist   ← tool.ts: tool_result_persist (优先级 50，同步)
    ├── openclaw.compaction.before     ← compaction.ts: before_compaction (优先级 60)
    ├── openclaw.compaction.after      ← compaction.ts: after_compaction (优先级 -60)
    ├── openclaw.message.sending       ← messages.ts: message_sending (优先级 60)
    └── openclaw.message.out           ← messages.ts: message_sent (优先级 50)
openclaw.session.end                   ← session.ts: session_end (优先级 -100，独立 Span)
```

**关键设计：**

1. **优先级驱动的执行顺序** — 高优先级钩子先执行，确保父 Span 在子 Span 之前创建（message:100 → action:90 → agent-run:80 → llm/model-call/compaction:60 → tool/message_out:50）；负优先级钩子后执行，确保子 Span 在父 Span 之前关闭（tool:-50 → model-call:-60 → agent-run 兜底:-90 → action:-100）。

2. **异步安全的会话隔离** — `state.ts` 中的 Map 以 session key 为键，支持并发会话互不干扰。工具调用使用 LIFO 栈处理嵌套/顺序调用；Provider 调用以 `runId::callId` 精确配对，天然支持并发与重试。

3. **配置驱动的细粒度控制** — 每类拦截器可通过布尔标志独立启用/禁用（`captureAction`、`captureAgentRun`、`captureMessages`、`captureMessageSending`、`captureTool`、`captureToolResultPersist`、`captureModelCall`、`captureSession`、`captureCompaction`、`captureLlm*`），支持按需调节隐私和性能。

4. **双通道导出** — Span 同时发送到 OTLP/HTTP 端点（用于 Jaeger/Grafana 等后端）和本地 NDJSON 文件（标准 OTLP/JSON 编码，用于离线分析），两者均通过 `BatchSpanProcessor` 批量处理；`otlpEnabled=false` 可切换为纯 NDJSON 离线模式。

5. **跨版本兼容** — 依据宿主 `registerTypedHook` 的实测行为（未知 hook 名仅告警、不抛错），插件同时注册新旧两套名字：输入门禁 `before_agent_run` ↔ `before_agent_start`、压缩 `*_compaction` ↔ `*_context_prune`。同一宿主上两套名字互斥，故不会重复计数（有专用用例断言）。

6. **容错设计** — 每个 hook 处理器内部 `try/catch` 吞掉异常，遥测故障绝不影响宿主主流程；`agent_end` 会关闭孤立的工具 Span 与残留的 Provider 调用 Span。
