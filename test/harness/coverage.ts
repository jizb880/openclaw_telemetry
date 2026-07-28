/**
 * Hook coverage manifest — the single source of truth for:
 *   1. which hooks this plugin claims to capture,
 *   2. which span each hook produces,
 *   3. which attributes MUST be present for the capture to count as working,
 *   4. how the requested field names map onto real host event fields.
 *
 * The E2E suite asserts this manifest against spans actually exported, and the
 * sample generator renders it into `samples/`. If you add a hook, add it here
 * or the completeness test fails.
 */

export type HookCoverage = {
  hook: string;
  /** Span name the capture lands on. */
  span: string;
  /** Attributes that must exist and be non-empty after a normal turn. */
  requiredAttributes: string[];
  /** Requested field name → where it actually comes from on the host event. */
  fieldMapping?: Array<{ requested: string; hostField: string; attribute: string; note?: string }>;
  /** Host gates this behind `allowConversationAccess`. */
  conversationHook?: boolean;
  /** Only present on hosts new enough to fire it. */
  minHost?: string;
  /** Legacy hook names we also register for older hosts. */
  legacyAliases?: string[];
  notes?: string;
};

export const HOOK_COVERAGE: HookCoverage[] = [
  {
    hook: "session_start",
    span: "openclaw.session.start",
    requiredAttributes: ["openclaw.session.key", "openclaw.session.id", "openclaw.hook"],
  },
  {
    hook: "message_received",
    span: "openclaw.request",
    requiredAttributes: [
      "openclaw.session.key",
      "openclaw.message.channel",
      "openclaw.message.from",
      "openclaw.message.direction",
      "openclaw.message.content_length",
    ],
  },
  {
    hook: "before_agent_run",
    span: "openclaw.agent.run",
    requiredAttributes: [
      "openclaw.session.key",
      "openclaw.agent_run.content",
      "openclaw.agent_run.system_prompt",
      "openclaw.agent_run.history_count",
    ],
    fieldMapping: [
      { requested: "content", hostField: "prompt", attribute: "openclaw.agent_run.content" },
      { requested: "systemPrompt", hostField: "systemPrompt", attribute: "openclaw.agent_run.system_prompt" },
      {
        requested: "historyCount",
        hostField: "messages",
        attribute: "openclaw.agent_run.history_count",
        note: "derived: messages.length (host has no historyCount field)",
      },
    ],
    conversationHook: true,
    minHost: "2026.7",
    legacyAliases: ["before_agent_start"],
    notes: "Input gate. On old hosts the span is opened and closed from before_agent_start/agent_end instead.",
  },
  {
    hook: "llm_input",
    span: "openclaw.llm.input",
    requiredAttributes: [
      "openclaw.session.key",
      "openclaw.llm.content",
      "openclaw.llm.system_prompt",
      "openclaw.llm.history_count",
      "openclaw.llm.observe_only",
      "gen_ai.system",
      "gen_ai.request.model",
    ],
    fieldMapping: [
      { requested: "content", hostField: "prompt", attribute: "openclaw.llm.content" },
      { requested: "systemPrompt", hostField: "systemPrompt", attribute: "openclaw.llm.system_prompt" },
      {
        requested: "historyCount",
        hostField: "historyMessages",
        attribute: "openclaw.llm.history_count",
        note: "derived: historyMessages.length",
      },
      {
        requested: "observeOnly:true",
        hostField: "(none)",
        attribute: "openclaw.llm.observe_only",
        note: "not a host field; the hook is read-only by contract, we stamp the flag ourselves",
      },
    ],
    conversationHook: true,
  },
  {
    hook: "model_call_started",
    span: "openclaw.model_call",
    requiredAttributes: [
      "openclaw.run.id",
      "openclaw.model_call.id",
      "gen_ai.system",
      "gen_ai.request.model",
    ],
    notes: "Sanitized: no prompt/response/headers by host design.",
  },
  {
    hook: "model_call_ended",
    span: "openclaw.model_call",
    requiredAttributes: [
      "openclaw.model_call.duration_ms",
      "openclaw.model_call.ttfb_ms",
      "openclaw.model_call.response_stream_bytes",
      "openclaw.model_call.outcome",
    ],
    notes: "TTFB and streamed byte counts arrive on ended, not started.",
  },
  {
    hook: "llm_output",
    span: "openclaw.llm.output",
    requiredAttributes: [
      "openclaw.session.key",
      "openclaw.llm.content",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
    ],
    fieldMapping: [
      {
        requested: "content",
        hostField: "assistantTexts",
        attribute: "openclaw.llm.content",
        note: "derived: assistantTexts.join('') — host aggregates the stream, there is no single content field",
      },
      { requested: "usage", hostField: "usage", attribute: "gen_ai.usage.*" },
    ],
    conversationHook: true,
  },
  {
    hook: "before_tool_call",
    span: "openclaw.tool.web_search",
    requiredAttributes: ["openclaw.session.key", "openclaw.tool.name", "openclaw.tool.input"],
    fieldMapping: [
      { requested: "toolName", hostField: "toolName", attribute: "openclaw.tool.name" },
      { requested: "params", hostField: "params", attribute: "openclaw.tool.input" },
      {
        requested: "paramsText",
        hostField: "params",
        attribute: "openclaw.tool.input",
        note: "derived: JSON.stringify(params) (host has no paramsText field)",
      },
    ],
  },
  {
    hook: "after_tool_call",
    span: "openclaw.tool.web_search",
    requiredAttributes: [
      "openclaw.tool.output",
      "openclaw.tool.result_chars",
      "openclaw.tool.duration_ms",
    ],
    fieldMapping: [
      { requested: "toolName", hostField: "toolName", attribute: "openclaw.tool.name" },
      { requested: "result", hostField: "result", attribute: "openclaw.tool.output" },
      {
        requested: "resultChars",
        hostField: "result",
        attribute: "openclaw.tool.result_chars",
        note: "derived: serialized result length (host has no resultChars field)",
      },
      { requested: "error", hostField: "error", attribute: "openclaw.tool.error", note: "error path only" },
    ],
  },
  {
    hook: "tool_result_persist",
    span: "openclaw.tool.result_persist",
    requiredAttributes: [
      "openclaw.session.key",
      "openclaw.tool.name",
      "openclaw.tool.persist_message",
      "openclaw.tool.persist_result",
      "openclaw.tool.persist_result_chars",
    ],
    fieldMapping: [
      {
        requested: "result",
        hostField: "message.content",
        attribute: "openclaw.tool.persist_result",
        note: "host has no separate result field; the payload is inside message",
      },
      { requested: "message", hostField: "message", attribute: "openclaw.tool.persist_message" },
    ],
    minHost: "2026.7",
    notes: "Handler MUST be synchronous — the host ignores and warns on a Promise return.",
  },
  {
    hook: "before_compaction",
    span: "openclaw.compaction.before",
    requiredAttributes: [
      "openclaw.session.key",
      "openclaw.compaction.phase",
      "openclaw.compaction.message_count",
      "openclaw.compaction.token_count",
    ],
    legacyAliases: ["before_context_prune"],
  },
  {
    hook: "after_compaction",
    span: "openclaw.compaction.after",
    requiredAttributes: [
      "openclaw.session.key",
      "openclaw.compaction.phase",
      "openclaw.compaction.compacted_count",
    ],
    legacyAliases: ["after_context_prune"],
  },
  {
    hook: "message_sending",
    span: "openclaw.message.sending",
    requiredAttributes: [
      "openclaw.session.key",
      "openclaw.message.to",
      "openclaw.message.content",
      "openclaw.message.direction",
    ],
    fieldMapping: [
      { requested: "content", hostField: "content", attribute: "openclaw.message.content" },
      { requested: "to", hostField: "to", attribute: "openclaw.message.to" },
    ],
  },
  {
    hook: "message_sent",
    span: "openclaw.message.out",
    requiredAttributes: ["openclaw.session.key", "openclaw.message.to", "openclaw.message.success"],
  },
  {
    hook: "before_agent_start",
    span: "openclaw.action",
    requiredAttributes: ["openclaw.session.key", "openclaw.agent.id", "openclaw.agent.model"],
    notes: "Legacy combined phase; also opens the agent.run gate span for old hosts.",
  },
  {
    hook: "agent_end",
    span: "openclaw.action",
    requiredAttributes: [
      "openclaw.agent.success",
      "openclaw.agent.duration_ms",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
    ],
    conversationHook: true,
  },
  {
    hook: "session_end",
    span: "openclaw.session.end",
    requiredAttributes: [
      "openclaw.session.key",
      "openclaw.session.reason",
      "openclaw.session.message_count",
      "openclaw.session.duration_ms",
    ],
  },
];

/** Every hook name the plugin registers (including legacy aliases). */
export function allCoveredHookNames(): string[] {
  const names = new Set<string>();
  for (const c of HOOK_COVERAGE) {
    names.add(c.hook);
    for (const a of c.legacyAliases ?? []) names.add(a);
  }
  return [...names];
}
