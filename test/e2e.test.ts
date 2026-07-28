import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { HOOK_COVERAGE, allCoveredHookNames } from "./harness/coverage.js";
import {
  LEGACY_HOST,
  MODERN_HOST,
  MODERN_HOOK_NAMES,
  MODERN_HOST_NO_CONVERSATION_ACCESS,
  VENDORED_HOST_VERSION,
} from "./harness/mock-host.js";
import { cleanupTracerTmp, flushAndReadSpans, runScenario, type CapturedSpan } from "./harness/scenario.js";
import * as f from "./harness/fixtures.js";

after(() => cleanupTracerTmp());

/** Spans belonging to one scenario, identified by its session key. */
function spansFor(spans: CapturedSpan[], sessionKey: string): CapturedSpan[] {
  return spans.filter((s) => s.attributes["openclaw.session.key"] === sessionKey);
}

function findSpan(spans: CapturedSpan[], name: string): CapturedSpan | undefined {
  return spans.find((s) => s.name === name);
}

function nonEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  return true;
}

describe("hook registration completeness", () => {
  it("registers every hook declared in the coverage manifest", async () => {
    const r = await runScenario({ sessionKeySuffix: "reg" });
    for (const name of allCoveredHookNames()) {
      // Legacy aliases are correctly rejected by a modern host; skip those.
      if (!MODERN_HOOK_NAMES.includes(name)) continue;
      assert.ok(
        r.registeredHookNames.includes(name),
        `hook "${name}" is in the coverage manifest but was never registered`
      );
    }
  });

  it("registers no hook outside the coverage manifest", async () => {
    const r = await runScenario({ sessionKeySuffix: "reg2" });
    const covered = new Set(allCoveredHookNames());
    for (const name of r.registeredHookNames) {
      assert.ok(covered.has(name), `hook "${name}" is registered but undocumented in the coverage manifest`);
    }
  });

  it("only registers hook names the installed host actually defines", () => {
    const legacyOnly = new Set(["before_context_prune", "after_context_prune"]);
    for (const name of allCoveredHookNames()) {
      if (legacyOnly.has(name)) continue;
      assert.ok(
        MODERN_HOOK_NAMES.includes(name),
        `hook "${name}" is not a valid hook on host ${VENDORED_HOST_VERSION}`
      );
    }
  });

  it("matches the live installed host when one is present", () => {
    const hostTypes = `${process.env.HOME}/.npm-global/lib/node_modules/openclaw/dist/hook-types-DQ9eTy2x.d.ts`;
    if (!existsSync(hostTypes)) {
      // No host installed (e.g. CI) — the vendored fixture is authoritative.
      return;
    }
    const src = readFileSync(hostTypes, "utf8");
    const m = src.match(/declare const PLUGIN_HOOK_NAMES: readonly \[([^\]]+)\]/);
    assert.ok(m, "could not parse PLUGIN_HOOK_NAMES from the installed host");
    const live = m[1].split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    for (const name of MODERN_HOOK_NAMES) {
      assert.ok(live.includes(name), `vendored hook "${name}" no longer exists on the installed host`);
    }
  });
});

describe("end-to-end data capture (modern host)", () => {
  it("captures required attributes for every hook in the manifest", async () => {
    const r = await runScenario({
      sessionKeySuffix: "modern",
      includeCompaction: true,
      includeToolError: true,
    });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    assert.ok(spans.length > 0, "no spans were exported");

    const missing: string[] = [];
    for (const c of HOOK_COVERAGE) {
      const span = findSpan(spans, c.span);
      if (!span) {
        missing.push(`${c.hook}: span "${c.span}" was never exported`);
        continue;
      }
      for (const attr of c.requiredAttributes) {
        if (!nonEmpty(span.attributes[attr])) {
          missing.push(`${c.hook}: span "${c.span}" is missing attribute "${attr}"`);
        }
      }
    }
    assert.deepEqual(missing, [], `incomplete capture:\n  ${missing.join("\n  ")}`);
  });

  it("maps every requested field to a populated attribute", async () => {
    const r = await runScenario({ sessionKeySuffix: "fields", includeCompaction: true });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);

    const problems: string[] = [];
    for (const c of HOOK_COVERAGE) {
      for (const fm of c.fieldMapping ?? []) {
        if (fm.note?.includes("error path")) continue;
        const span = findSpan(spans, c.span);
        if (!span) {
          problems.push(`${c.hook}.${fm.requested}: span missing`);
          continue;
        }
        // Wildcard attributes (gen_ai.usage.*) match by prefix.
        const key = fm.attribute;
        const ok = key.endsWith("*")
          ? Object.keys(span.attributes).some((k) => k.startsWith(key.slice(0, -1)) && nonEmpty(span.attributes[k]))
          : nonEmpty(span.attributes[key]);
        if (!ok) problems.push(`${c.hook}.${fm.requested} → ${key} not populated`);
      }
    }
    assert.deepEqual(problems, [], `field mapping gaps:\n  ${problems.join("\n  ")}`);
  });

  it("captures the exact prompt, system prompt and history count on the input gate", async () => {
    const r = await runScenario({ sessionKeySuffix: "gate" });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const gate = findSpan(spans, "openclaw.agent.run");
    assert.ok(gate, "agent.run span missing");
    assert.equal(gate.attributes["openclaw.agent_run.content"], f.USER_PROMPT);
    assert.equal(gate.attributes["openclaw.agent_run.system_prompt"], f.SYSTEM_PROMPT);
    assert.equal(gate.attributes["openclaw.agent_run.history_count"], f.HISTORY_MESSAGES.length);
    assert.equal(gate.attributes["openclaw.agent_run.source"], "before_agent_run");
  });

  it("aggregates llm_output assistantTexts into one content attribute with usage", async () => {
    const r = await runScenario({ sessionKeySuffix: "out" });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const out = findSpan(spans, "openclaw.llm.output");
    assert.ok(out, "llm.output span missing");
    assert.equal(out.attributes["openclaw.llm.content"], f.ASSISTANT_REPLY);
    assert.equal(out.attributes["gen_ai.usage.input_tokens"], 4912);
    assert.equal(out.attributes["gen_ai.usage.output_tokens"], 118);
    assert.equal(out.attributes["openclaw.llm.usage.total_tokens"], 5030);
  });

  it("records TTFB and streamed bytes on the model call span", async () => {
    const r = await runScenario({ sessionKeySuffix: "mc" });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const mc = findSpan(spans, "openclaw.model_call");
    assert.ok(mc, "model_call span missing");
    assert.equal(mc.attributes["openclaw.model_call.ttfb_ms"], 486);
    assert.equal(mc.attributes["openclaw.model_call.response_stream_bytes"], 2048);
    assert.equal(mc.attributes["openclaw.model_call.duration_ms"], 3412);
    assert.equal(mc.attributes["openclaw.model_call.outcome"], "completed");
  });

  it("captures tool params, result and derived resultChars", async () => {
    const r = await runScenario({ sessionKeySuffix: "tool" });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const tool = findSpan(spans, "openclaw.tool.web_search");
    assert.ok(tool, "tool span missing");
    assert.equal(tool.attributes["openclaw.tool.input"], JSON.stringify(f.TOOL_PARAMS));
    assert.equal(tool.attributes["openclaw.tool.output"], JSON.stringify(f.TOOL_RESULT));
    assert.equal(
      tool.attributes["openclaw.tool.result_chars"],
      JSON.stringify(f.TOOL_RESULT).length
    );
  });

  it("records tool errors with ERROR status", async () => {
    const r = await runScenario({ sessionKeySuffix: "toolerr", includeToolError: true });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const errSpan = spans.find((s) => s.name === "openclaw.tool.exec");
    assert.ok(errSpan, "failing tool span missing");
    assert.match(String(errSpan.attributes["openclaw.tool.error"]), /ENOTFOUND/);
    assert.equal(errSpan.status?.code, 2, "expected SpanStatusCode.ERROR");
  });

  it("captures the tool_result_persist payload out of message.content", async () => {
    const r = await runScenario({ sessionKeySuffix: "persist" });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const p = findSpan(spans, "openclaw.tool.result_persist");
    assert.ok(p, "result_persist span missing");
    assert.equal(p.attributes["openclaw.tool.name"], "web_search");
    assert.match(String(p.attributes["openclaw.tool.persist_result"]), /多云转晴/);
    assert.equal(p.attributes["openclaw.tool.is_synthetic"], false);
  });

  it("captures outbound content and target on message_sending", async () => {
    const r = await runScenario({ sessionKeySuffix: "send" });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const s = findSpan(spans, "openclaw.message.sending");
    assert.ok(s, "message.sending span missing");
    assert.equal(s.attributes["openclaw.message.content"], f.ASSISTANT_REPLY);
    assert.equal(s.attributes["openclaw.message.to"], "user-777");
  });

  it("captures both compaction phases", async () => {
    const r = await runScenario({ sessionKeySuffix: "compact", includeCompaction: true });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const before = findSpan(spans, "openclaw.compaction.before");
    const afterSpan = findSpan(spans, "openclaw.compaction.after");
    assert.ok(before, "compaction.before span missing");
    assert.ok(afterSpan, "compaction.after span missing");
    assert.equal(before.attributes["openclaw.compaction.message_count"], 128);
    assert.equal(before.attributes["openclaw.hook"], "before_compaction");
    assert.equal(afterSpan.attributes["openclaw.compaction.compacted_count"], 96);
  });

  it("captures session lifecycle boundaries", async () => {
    const r = await runScenario({ sessionKeySuffix: "sess" });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const start = findSpan(spans, "openclaw.session.start");
    const end = findSpan(spans, "openclaw.session.end");
    assert.ok(start, "session.start span missing");
    assert.ok(end, "session.end span missing");
    assert.equal(end.attributes["openclaw.session.reason"], "idle");
    assert.equal(end.attributes["openclaw.session.message_count"], 6);
  });

  it("nests tool and llm spans under the agent action span", async () => {
    const r = await runScenario({ sessionKeySuffix: "tree" });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const action = findSpan(spans, "openclaw.action");
    const tool = findSpan(spans, "openclaw.tool.web_search");
    assert.ok(action && tool, "action or tool span missing");
    assert.equal(tool.parentSpanId, action.spanId, "tool span is not a child of the action span");
    assert.equal(tool.traceId, action.traceId, "tool span is in a different trace");
  });
});

describe("backward compatibility", () => {
  it("degrades gracefully on a legacy host without throwing", async () => {
    const r = await runScenario({ profile: LEGACY_HOST, sessionKeySuffix: "legacy", includeCompaction: true });
    // Hooks the old host does not know must be rejected, not crash.
    const rejectedNames = r.rejected.map((x) => x.hookName);
    for (const missing of ["before_agent_run", "tool_result_persist", "model_call_started", "model_call_ended"]) {
      assert.ok(rejectedNames.includes(missing), `expected legacy host to reject "${missing}"`);
    }
    assert.ok(r.registeredHookNames.includes("before_agent_start"));
  });

  it("still captures the input gate on a legacy host via before_agent_start", async () => {
    const r = await runScenario({ profile: LEGACY_HOST, sessionKeySuffix: "legacygate" });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const gate = findSpan(spans, "openclaw.agent.run");
    assert.ok(gate, "agent.run span missing on legacy host");
    assert.equal(gate.attributes["openclaw.agent_run.source"], "before_agent_start");
    assert.equal(gate.attributes["openclaw.agent_run.content"], f.USER_PROMPT);
    assert.equal(gate.attributes["openclaw.agent_run.history_count"], f.HISTORY_MESSAGES.length);
  });

  it("captures compaction via the legacy *_context_prune aliases", async () => {
    const r = await runScenario({
      profile: LEGACY_HOST,
      sessionKeySuffix: "legacyprune",
      includeCompaction: true,
    });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const before = findSpan(spans, "openclaw.compaction.before");
    const afterSpan = findSpan(spans, "openclaw.compaction.after");
    assert.ok(before, "compaction.before missing on legacy host");
    assert.ok(afterSpan, "compaction.after missing on legacy host");
    assert.equal(before.attributes["openclaw.hook"], "before_context_prune");
    assert.equal(afterSpan.attributes["openclaw.hook"], "after_context_prune");
  });

  it("does not double-count compaction on a modern host", async () => {
    const r = await runScenario({ sessionKeySuffix: "nodouble", includeCompaction: true });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    const befores = spans.filter((s) => s.name === "openclaw.compaction.before");
    assert.equal(befores.length, 1, "compaction captured twice — legacy alias double-fired");
  });

  it("keeps the tool_result_persist handler synchronous", async () => {
    // The mock host throws if the handler returns a Promise, mirroring the
    // host's "returned a Promise; result ignored" warning.
    await runScenario({ sessionKeySuffix: "sync" });
  });
});

describe("conversation access gating", () => {
  it("blocks conversation hooks when allowConversationAccess is not set", async () => {
    const r = await runScenario({
      profile: MODERN_HOST_NO_CONVERSATION_ACCESS,
      sessionKeySuffix: "noaccess",
    });
    const rejectedNames = r.rejected.map((x) => x.hookName);
    for (const gated of ["llm_input", "llm_output", "before_agent_run", "agent_end"]) {
      assert.ok(rejectedNames.includes(gated), `expected "${gated}" to be blocked without conversation access`);
    }
    // Non-conversation hooks still work.
    assert.ok(r.registeredHookNames.includes("before_tool_call"));
    assert.ok(r.registeredHookNames.includes("session_start"));
  });

  it("captures non-conversation hooks even when conversation access is denied", async () => {
    const r = await runScenario({
      profile: MODERN_HOST_NO_CONVERSATION_ACCESS,
      sessionKeySuffix: "noaccess2",
    });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    assert.ok(findSpan(spans, "openclaw.tool.web_search"), "tool span should still be captured");
    assert.ok(findSpan(spans, "openclaw.session.start"), "session span should still be captured");
    assert.equal(findSpan(spans, "openclaw.llm.input"), undefined, "llm.input must be absent when gated");
  });
});

describe("capture flags", () => {
  it("honors captureTool=false", async () => {
    const r = await runScenario({ sessionKeySuffix: "notool", config: { captureTool: false } });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    assert.equal(findSpan(spans, "openclaw.tool.web_search"), undefined);
    assert.ok(findSpan(spans, "openclaw.session.start"), "other captures should be unaffected");
  });

  it("honors captureLlmOutput=false while keeping llm_input", async () => {
    const r = await runScenario({
      sessionKeySuffix: "noout",
      config: { captureLlmOutput: false },
    });
    const spans = spansFor(await flushAndReadSpans(), r.sessionKey);
    assert.equal(findSpan(spans, "openclaw.llm.output"), undefined);
    assert.ok(findSpan(spans, "openclaw.llm.input"), "llm.input should still be captured");
  });
});
