/**
 * Realistic hook event payloads.
 *
 * Every field name here is taken from the installed host's
 * `dist/hook-types-DQ9eTy2x.d.ts` (OpenClaw 2026.7.1-2) so the fixtures exercise
 * the same shapes production hooks deliver. Do not "tidy" field names — e.g.
 * `before_agent_run` really carries `prompt` + `messages` (not `content` +
 * `historyCount`), and `llm_output` really carries `assistantTexts: string[]`.
 */

export const SESSION_KEY = "agent:main:discord:chan-42";
export const SESSION_ID = "sess-01JQ8X2Y3Z";
export const RUN_ID = "9f1c2e7a-4b6d-4f10-9c3e-7a2b5d8e1f04";
export const CALL_ID = "call-0001";
export const TOOL_CALL_ID = "toolu_01ABCDEF";

/** `PluginHookAgentContext` — passed as the 2nd arg to agent-turn hooks. */
export const agentCtx = {
  runId: RUN_ID,
  sessionKey: SESSION_KEY,
  sessionId: SESSION_ID,
  agentId: "main",
  modelProviderId: "anthropic",
  modelId: "claude-opus-4-8",
  channel: "discord",
  channelId: "chan-42",
  senderId: "user-777",
  workspaceDir: "/workspace/demo",
  contextTokenBudget: 200_000,
  contextWindowSource: "model",
};

/** `PluginHookMessageContext` — passed to message hooks. */
export const messageCtx = {
  channelId: "discord",
  sessionKey: SESSION_KEY,
  runId: RUN_ID,
  messageId: "msg-1001",
  senderId: "user-777",
};

/** `PluginHookToolContext` — passed to tool hooks. */
export const toolCtx = {
  agentId: "main",
  sessionKey: SESSION_KEY,
  sessionId: SESSION_ID,
  runId: RUN_ID,
  toolName: "web_search",
  toolCallId: TOOL_CALL_ID,
  channelId: "discord",
};

/** `PluginHookSessionContext` */
export const sessionCtx = {
  agentId: "main",
  sessionId: SESSION_ID,
  sessionKey: SESSION_KEY,
};

export const USER_PROMPT = "帮我查一下上海明天的天气，然后总结成一句话。";
export const SYSTEM_PROMPT = "You are OpenClaw, a helpful autonomous agent. Answer concisely.";
export const ASSISTANT_REPLY = "上海明天多云转晴，气温 24-31°C，适合外出。";

/** History as the host passes it: an array of agent messages. */
export const HISTORY_MESSAGES: unknown[] = [
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好！有什么可以帮你的吗？" },
  { role: "user", content: "记住我住在上海" },
  { role: "assistant", content: "好的，已记住。" },
];

export const TOOL_PARAMS = { query: "上海 明天 天气", max_results: 3 };

export const TOOL_RESULT = {
  content: [{ type: "text", text: "上海：明天多云转晴，24-31°C，东南风 3 级。" }],
  isError: false,
};

/** `PluginHookSessionStartEvent` */
export const sessionStartEvent = {
  sessionId: SESSION_ID,
  sessionKey: SESSION_KEY,
  resumedFrom: undefined,
};

/** `PluginHookMessageReceivedEvent` */
export const messageReceivedEvent = {
  from: "user-777",
  content: USER_PROMPT,
  timestamp: 1_770_000_000_000,
  messageId: "msg-1001",
  senderId: "user-777",
  sessionKey: SESSION_KEY,
  runId: RUN_ID,
};

/** `PluginHookBeforeAgentStartEvent` (legacy combined phase). */
export const beforeAgentStartEvent = {
  prompt: USER_PROMPT,
  runId: RUN_ID,
  messages: HISTORY_MESSAGES,
  sessionKey: SESSION_KEY,
};

/** `PluginHookBeforeAgentRunEvent` — the real input gate. */
export const beforeAgentRunEvent = {
  prompt: USER_PROMPT,
  messages: HISTORY_MESSAGES,
  systemPrompt: SYSTEM_PROMPT,
  accountId: "acct-1",
  channelId: "discord",
  senderId: "user-777",
  senderIsOwner: true,
};

/** `PluginHookLlmInputEvent` */
export const llmInputEvent = {
  runId: RUN_ID,
  sessionId: SESSION_ID,
  provider: "anthropic",
  model: "claude-opus-4-8",
  systemPrompt: SYSTEM_PROMPT,
  prompt: USER_PROMPT,
  historyMessages: HISTORY_MESSAGES,
  imagesCount: 0,
  tools: [{ name: "web_search" }, { name: "exec" }],
};

/** `PluginHookModelCallStartedEvent` */
export const modelCallStartedEvent = {
  runId: RUN_ID,
  callId: CALL_ID,
  sessionKey: SESSION_KEY,
  sessionId: SESSION_ID,
  provider: "anthropic",
  model: "claude-opus-4-8",
  api: "messages",
  transport: "https",
  contextTokenBudget: 200_000,
  contextWindowSource: "model",
};

/** `PluginHookModelCallEndedEvent` — TTFB and stream bytes live here. */
export const modelCallEndedEvent = {
  ...modelCallStartedEvent,
  durationMs: 3_412,
  outcome: "completed" as const,
  requestPayloadBytes: 18_204,
  responseStreamBytes: 2_048,
  timeToFirstByteMs: 486,
  upstreamRequestIdHash: "sha256:7d4f9c1e2a",
};

/** `PluginHookLlmOutputEvent` — host has already aggregated the stream. */
export const llmOutputEvent = {
  runId: RUN_ID,
  sessionId: SESSION_ID,
  provider: "anthropic",
  model: "claude-opus-4-8",
  resolvedRef: "anthropic/claude-opus-4-8",
  harnessId: "embedded",
  prompt: USER_PROMPT,
  assistantTexts: [ASSISTANT_REPLY],
  lastAssistant: { role: "assistant", content: ASSISTANT_REPLY },
  usage: { input: 4_912, output: 118, cacheRead: 3_800, cacheWrite: 0, total: 5_030 },
  reasoningEffort: "medium",
  fastMode: false,
  contextTokenBudget: 200_000,
};

/** `PluginHookBeforeToolCallEvent` */
export const beforeToolCallEvent = {
  toolName: "web_search",
  params: TOOL_PARAMS,
  runId: RUN_ID,
  toolCallId: TOOL_CALL_ID,
};

/** `PluginHookAfterToolCallEvent` */
export const afterToolCallEvent = {
  toolName: "web_search",
  params: TOOL_PARAMS,
  runId: RUN_ID,
  toolCallId: TOOL_CALL_ID,
  result: TOOL_RESULT,
  durationMs: 742,
};

/** `PluginHookAfterToolCallEvent` on the failure path. */
export const afterToolCallErrorEvent = {
  toolName: "exec",
  params: { command: "curl https://example.invalid" },
  runId: RUN_ID,
  toolCallId: "toolu_02FAIL",
  error: "getaddrinfo ENOTFOUND example.invalid",
  durationMs: 51,
};

/** `PluginHookToolResultPersistEvent` — result lives inside `message`. */
export const toolResultPersistEvent = {
  toolName: "web_search",
  toolCallId: TOOL_CALL_ID,
  isSynthetic: false,
  message: {
    role: "toolResult",
    content: [{ type: "text", text: "上海：明天多云转晴，24-31°C，东南风 3 级。" }],
    toolCallId: TOOL_CALL_ID,
  },
};

/** `PluginHookBeforeCompactionEvent` */
export const beforeCompactionEvent = {
  messageCount: 128,
  compactingCount: 96,
  tokenCount: 181_400,
  sessionFile: "/workspace/demo/.openclaw/sessions/sess-01JQ8X2Y3Z.jsonl",
};

/** `PluginHookAfterCompactionEvent` */
export const afterCompactionEvent = {
  messageCount: 34,
  compactedCount: 96,
  tokenCount: 42_100,
  sessionFile: "/workspace/demo/.openclaw/sessions/sess-01JQ8X2Y3Z.jsonl",
  previousSessionId: SESSION_ID,
};

/** `PluginHookMessageSendingEvent` */
export const messageSendingEvent = {
  to: "user-777",
  content: ASSISTANT_REPLY,
  threadId: "thread-9",
};

/** `PluginHookMessageSentEvent` */
export const messageSentEvent = {
  to: "user-777",
  content: ASSISTANT_REPLY,
  success: true,
  messageId: "msg-1002",
  sessionKey: SESSION_KEY,
  runId: RUN_ID,
};

/** `PluginHookAgentEndEvent` */
export const agentEndEvent = {
  runId: RUN_ID,
  success: true,
  durationMs: 5_118,
  messages: [
    ...HISTORY_MESSAGES,
    { role: "user", content: USER_PROMPT },
    {
      role: "assistant",
      content: ASSISTANT_REPLY,
      model: "claude-opus-4-8",
      usage: { input: 4_912, output: 118 },
    },
  ],
};

/** `PluginHookSessionEndEvent` */
export const sessionEndEvent = {
  sessionId: SESSION_ID,
  sessionKey: SESSION_KEY,
  messageCount: 6,
  durationMs: 61_004,
  reason: "idle" as const,
  sessionFile: "/workspace/demo/.openclaw/sessions/sess-01JQ8X2Y3Z.jsonl",
  transcriptArchived: true,
};
