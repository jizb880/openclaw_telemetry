# openclaw_telemetry

面向 [OpenClaw](https://github.com/openclaw) 网关与智能体的 OpenTelemetry 追踪插件。它把 OpenClaw 插件生命周期中的**全部关键 hook 点**记录为相互关联的 Span：会话开始/结束、输入门禁、LLM 上下文与输出、Provider 调用（TTFB/流式字节等脱敏指标）、工具前置/后置/持久化、消息进出、以及上下文压缩。Span 通过 **OTLP/HTTP** 导出，同时可选**追加写入本地 NDJSON 文件**（标准 OTLP/JSON 编码）以便离线查看。

> 语言：**中文（本文档）** · [English](README.en.md)

仓库：[github.com/jizb880/openclaw_telemetry](https://github.com/jizb880/openclaw_telemetry) ｜ 架构说明：[ARCHITECTURE.md](ARCHITECTURE.md)

---

## 一、采集的 Hook 点全景

下表是本插件采集的**全部 17 个语义 hook**（对应 15 类 Span），以及每个 hook 落到哪个 Span、必备属性、以及“请求字段 → 宿主真实字段”的映射。**此表由代码中的唯一事实源 [`test/harness/coverage.ts`](test/harness/coverage.ts) 生成，端到端测试会逐条校验，样例数据 [`samples/coverage.json`](samples/coverage.json) 与之同步。**

| Hook | Span | 需授权¹ | 最低宿主 | 旧版别名 | 说明 |
|------|------|:---:|:---:|------|------|
| `session_start` | `openclaw.session.start` | | | | 会话开启 |
| `message_received` | `openclaw.request` | | | | 入站消息，建立会话根 trace |
| `before_agent_run` | `openclaw.agent.run` | ✅ | 2026.7 | `before_agent_start` | 输入门禁（可阻断） |
| `llm_input` | `openclaw.llm.input` | ✅ | | | 进入 LLM 前的完整上下文（只读） |
| `model_call_started` | `openclaw.model_call` | | | | Provider 调用起点（脱敏） |
| `model_call_ended` | `openclaw.model_call` | | | | TTFB、流式字节、耗时（脱敏） |
| `llm_output` | `openclaw.llm.output` | ✅ | | | 宿主已聚合的完整回复 + 用量 |
| `before_tool_call` | `openclaw.tool.<name>` | | | | 工具前置拦截 |
| `after_tool_call` | `openclaw.tool.<name>` | | | | 工具后置只读观察 |
| `tool_result_persist` | `openclaw.tool.result_persist` | | 2026.7 | | 写回记忆前改写（**必须同步**） |
| `before_compaction` | `openclaw.compaction.before` | | | `before_context_prune` | 上下文压缩前 |
| `after_compaction` | `openclaw.compaction.after` | | | `after_context_prune` | 上下文压缩后 |
| `message_sending` | `openclaw.message.sending` | | | | 出站消息挂载（可改写/取消） |
| `message_sent` | `openclaw.message.out` | | | | 出站已发送 |
| `before_agent_start` | `openclaw.action` | | | | 智能体轮次开始（旧版兼容） |
| `agent_end` | `openclaw.action` | ✅ | | | 轮次结束，写入用量/模型 |
| `session_end` | `openclaw.session.end` | | | | 会话收尾 |

¹ **需授权**：属于宿主 `CONVERSATION_HOOK_NAMES` 的会话类 hook。非内置插件必须在配置中设 `plugins.entries.<id>.hooks.allowConversationAccess = true`，否则宿主直接拦截注册，这几条数据**默认采不到**。详见 [第五节](#五向后兼容与授权)。

### 字段映射（请求字段 → 宿主真实字段）

你最初要求的部分字段名与宿主事件实际字段不同，本插件已做映射并在 Span 属性上落地：

| Hook | 你请求的字段 | 宿主真实字段 | Span 属性 |
|------|------|------|------|
| `before_agent_run` | `content` | `prompt` | `openclaw.agent_run.content` |
| | `historyCount` | `messages`（取 `.length`） | `openclaw.agent_run.history_count` |
| `llm_input` | `content` | `prompt` | `openclaw.llm.content` |
| | `historyCount` | `historyMessages`（取 `.length`） | `openclaw.llm.history_count` |
| | `observeOnly:true` | （宿主无此字段，契约即只读） | `openclaw.llm.observe_only=true` |
| `llm_output` | `content` | `assistantTexts`（`join('')`） | `openclaw.llm.content` |
| `before_tool_call` | `paramsText` | `params`（`JSON.stringify`） | `openclaw.tool.input` |
| `after_tool_call` | `resultChars` | `result`（序列化后长度） | `openclaw.tool.result_chars` |
| `tool_result_persist` | `result` | `message.content`（无独立字段） | `openclaw.tool.persist_result` |

---

## 二、快速开始

```bash
npm install
npm run build      # 产出 dist/index.js（插件入口）
```

在网关工作目录放置 `config/observability.json`（见 [第四节](#四配置)），或用环境变量 `OBSERVABILITY_CONFIG` 指定绝对路径。插件仅在 `api.registrationMode` 为 `"full"` 或未设置时注册；`setup-only` / `setup-runtime` 下不注册。

**采集会话类 hook（`before_agent_run` / `llm_input` / `llm_output` / `agent_end`）时**，还需在 OpenClaw 主配置中为本插件开启会话访问权限：

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

## 三、如何验证“当前版本 hook 点都能采到数据”

本项目提供**两条**互补的验证路径，并额外提供一套**完备性自检**证明两条路径都覆盖了全部 hook。

### 3.1 端到端测试验证（推荐，自动、可复现）

```bash
npm run verify
```

这一条命令依次执行：类型检查 → 端到端测试（25 个用例）→ 重新生成样例。测试做了什么：

- **逐 hook 断言**：通过内置 Mock 宿主，用与真实宿主**完全一致的字段名**构造事件，驱动整条插件链路，再把导出的 NDJSON Span 读回，逐条校验 [`coverage.ts`](test/harness/coverage.ts) 里声明的每个必备属性都存在且非空。
- **完备性自检**：把 `coverage.ts` 声明的 hook 集合与**从真实宿主导出的权威列表** [`test/fixtures/host-hook-names.json`](test/fixtures/host-hook-names.json) 交叉比对——若宿主新增了某个 hook 而清单未覆盖，测试**失败**。这正是“验证完备性”的机制。
- **向后兼容**：模拟旧宿主（无 `before_agent_run`、用 `*_context_prune` 旧别名），断言不抛错且仍能采到数据；同时断言新宿主下**不会重复计数**。
- **授权门禁**：断言未开 `allowConversationAccess` 时会话类 hook 被拦截、非会话类不受影响。
- **同步契约**：断言 `tool_result_persist` 处理器为同步（返回 Promise 会被宿主忽略并告警）。

期望输出结尾：`tests 25 / pass 25 / fail 0`。

> 宿主升级后同步权威列表：`npm run sync:host-hooks`（从本机安装的 OpenClaw 重新导出 `test/fixtures/host-hook-names.json`），随后 `npm run verify` 即可发现新增 hook。

### 3.2 手动测试验证（真实网关，肉眼确认）

1. 构建并注册插件：`npm run build`，在 OpenClaw 中加载 `dist/index.js`。
2. 采用 NDJSON-only 模式免搭 Collector：`config/observability.json` 里设 `otlpEnabled=false`、`otelSpanExportEnabled=true`、`otelSpanExportPath` 指向可写目录。
3. 若要采会话类 hook，按 [第二节](#二快速开始) 开 `allowConversationAccess=true`。
4. 在网关里完成**一整轮真实对话**，且至少触发一次工具调用；如需覆盖压缩类 hook，把会话拉长到触发上下文压缩。
5. 查看落盘文件 `openclaw-otel-spans.jsonl`，逐个 Span 展开：

   ```bash
   jq '.resourceSpans[].scopeSpans[].spans[].name' openclaw-otel-spans.jsonl | sort -u
   ```

6. **对照 [第一节](#一采集的-hook-点全景) 的 Span 列表逐一核对**。为确认手测的完备性，用下面这条命令列出“本应出现却缺失”的 Span：

   ```bash
   comm -13 \
     <(jq -r '.resourceSpans[].scopeSpans[].spans[].name' openclaw-otel-spans.jsonl | sort -u) \
     <(jq -r '.hooks[].span' samples/coverage.json | sort -u)
   ```

   输出为空即代表**当前宿主版本下你的手测已覆盖全部可触发的 hook**。若有输出，说明对应 hook 未被触发（例如没开会话授权、宿主版本过低、或该轮未调用工具/未触发压缩），据此补触发条件即可。

   > 注意：工具 Span 名为动态的 `openclaw.tool.<工具名>`，`coverage.json` 里以 `openclaw.tool.web_search` 作代表。若你实际调用的工具名不同，它可能被误报为“缺失”——只要落盘里存在**任意** `openclaw.tool.*`（且有 `openclaw.tool.result_persist`），即视为工具链路已覆盖。

> 手测与端到端的关系：端到端用 Mock 宿主保证**逻辑与字段映射**完备且可复现；手测在**真实宿主**上确认 hook 确实触发、授权确实生效。两者共用同一份 `coverage.json`，因此“完备”的判定标准一致。

---

## 四、配置

默认读取工作目录下的 `config/observability.json`；也可用 `OBSERVABILITY_CONFIG` 指定绝对路径。未识别的键会被忽略，缺失键回落默认值。

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `true` | 总开关。 |
| `serviceName` | string | `openclaw` | 资源属性 `service.name`。 |
| `otlpEndpoint` | string | `http://localhost:4318/v1/traces` | OTLP HTTP 上报地址。 |
| `otlpEnabled` | boolean | `true` | 设为 `false` 时**完全跳过** OTLP 导出器，仅写 NDJSON（离线/本地验证很有用）。 |
| `otelSpanExportEnabled` | boolean | `true` | 是否把 Span 批次追加写入本地 NDJSON 文件。 |
| `otelSpanExportPath` | string | `.` | 目录（默认文件名 `openclaw-otel-spans.jsonl`），或以 `.jsonl` 结尾的完整路径。 |
| `captureAction` | boolean | `true` | `before_agent_start` / `agent_end`。 |
| `captureAgentRun` | boolean | `true` | `before_agent_run`（含旧版 `before_agent_start` 兜底）。 |
| `captureMessages` | boolean | `true` | `message_received` / `message_sent`。 |
| `captureMessageSending` | boolean | `true` | `message_sending`。 |
| `captureTool` | boolean | `true` | `before_tool_call` / `after_tool_call`。 |
| `captureToolResultPersist` | boolean | `true` | `tool_result_persist`。 |
| `captureModelCall` | boolean | `true` | `model_call_started` / `model_call_ended`。 |
| `captureSession` | boolean | `true` | `session_start` / `session_end`。 |
| `captureCompaction` | boolean | `true` | `before_compaction` / `after_compaction`（含旧别名）。 |
| `captureLlm` | boolean | `true` | LLM 采集总开关。 |
| `captureLlmInput` | boolean | `true` | `llm_input` 与 `gen_ai.prompt`。 |
| `captureLlmOutput` | boolean | `true` | `llm_output` 与用量。 |
| `captureToolInput` | boolean | `true` | 工具入参。 |
| `captureToolOutput` | boolean | `true` | 工具出参与持久化载荷。 |

**隐私提示：** 提示词、工具载荷、持久化消息可能含敏感信息。生产环境按需关闭对应 `capture*` 开关或关闭文件导出。属性值统一截断至 8000 字符。

---

## 五、向后兼容与授权

**兼容策略基于宿主 `registerTypedHook` 的实测行为：未知 hook 名会被静默忽略（仅告警），不会抛错。** 因此插件同时注册新旧两套名字，在任一宿主上只有它认识的那套会真正生效：

- **输入门禁**：新宿主由 `before_agent_start` 开启 `openclaw.agent.run` Span、由 `before_agent_run` 补齐 `systemPrompt` 与权威 `historyCount` 后关闭；旧宿主没有 `before_agent_run`，则由 `agent_end` 兜底关闭，Span 上的 `openclaw.agent_run.source` 会标明数据来源。
- **上下文压缩**：同时注册 `before_compaction`/`after_compaction` 与旧别名 `before_context_prune`/`after_context_prune`。两套名字在同一宿主上互斥，因此不会重复计数（有专门用例断言）。
- **`tool_result_persist`**：宿主 ≥ 2026.7 才有；旧宿主上注册被忽略，其余采集不受影响。处理器**必须同步**，返回 Promise 会被宿主忽略并告警——测试会强制校验这一点。

> 已在 OpenClaw **2026.7.1-2** 上核对全部字段定义。当前宿主中**不存在** `*_context_prune` 别名（全包检索无命中），保留注册仅为兼容更早版本。

---

## 六、采集数据样例

仓库内 [`samples/`](samples/) 目录提交了由 `npm run samples` 生成的真实采集结果：

| 文件 | 内容 |
|------|------|
| [`samples/full-turn.otlp.ndjson`](samples/full-turn.otlp.ndjson) | 一整轮完整对话导出的全部 Span，标准 OTLP/JSON NDJSON，每行一个 `ExportTraceServiceRequest` |
| [`samples/spans/<hook>.json`](samples/spans/) | **每个 hook 一份**独立样例，含字段映射说明与该 hook 实际产出的 Span 属性 |
| [`samples/coverage.json`](samples/coverage.json) | 机器可读的 hook 覆盖清单，手测完备性核对脚本直接消费它 |

以 `before_agent_run` 为例（节选自 [`samples/spans/before-agent-run.json`](samples/spans/before-agent-run.json)）：

```json
{
  "hook": "before_agent_run",
  "span": "openclaw.agent.run",
  "conversationHook": true,
  "sampleSpan": {
    "name": "openclaw.agent.run",
    "attributes": {
      "openclaw.session.key": "agent:main:discord:chan-42#samples",
      "openclaw.hook": "before_agent_run",
      "openclaw.agent_run.source": "before_agent_run",
      "openclaw.agent_run.content": "帮我查一下上海明天的天气，然后总结成一句话。",
      "openclaw.agent_run.history_count": 4,
      "openclaw.agent_run.system_prompt": "You are OpenClaw, a helpful autonomous agent. Answer concisely.",
      "openclaw.agent_run.sender_is_owner": true
    }
  }
}
```

NDJSON 文件每行是一个标准 OTLP/JSON `ExportTraceServiceRequest`（`resourceSpans` → `scopeSpans` → `spans`），与 OTLP HTTP 上报载荷完全一致，可直接被 OTel Collector 的 `otlpjsonfile` receiver 消费。`kind` 与 `status.code` 为 OTLP proto 枚举（`kind`：1=INTERNAL、2=SERVER、3=CLIENT；`status.code`：1=OK、2=ERROR）。

---

## 七、编程方式接入

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

插件会注册一个后台 service，在停止时关闭 TracerProvider 并刷新 OTLP 与文件导出批次。`GlobalTracer` 另提供 `forceFlush()` 用于主动落盘。

---

## 八、脚本

| 命令 | 说明 |
|------|------|
| `npm run build` | 编译插件到 `dist/`。 |
| `npm run typecheck` | 仅类型检查。 |
| `npm test` | 编译并运行端到端测试（25 用例）。 |
| `npm run samples` | 重新生成 `samples/` 下的采集样例。 |
| `npm run verify` | **typecheck + test + samples**，一条命令完成全部验证。 |
| `npm run sync:host-hooks` | 从本机安装的 OpenClaw 重新导出权威 hook 列表。 |
| `npm run clean` | 清理 `dist/` 与 `.test-build/`。 |

## 环境要求

- Node.js ≥ 18
- OTLP 上报：需可接收 OTLP/HTTP 的 Collector 或后端（设 `otlpEnabled=false` 可免）
- 文件导出：路径可写，目录不存在时自动创建

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。

