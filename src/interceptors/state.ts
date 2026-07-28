import type { Context } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";

export interface SessionTraceState {
  rootSpan: Span;
  rootContext: Context;
  agentSpan?: Span;
  agentContext?: Context;
  startTime: number;
  /** Open `openclaw.agent.run` gate span, awaiting `before_agent_run`/`agent_end` to close. */
  gateSpan?: Span;
}

/** sessionKey → active request / agent trace */
export const sessionState = new Map<string, SessionTraceState>();

export interface PendingToolSpan {
  span: Span;
  toolName: string;
}

/** sessionKey → LIFO stack of in-flight tool spans (matches before/after order) */
export const toolStacks = new Map<string, PendingToolSpan[]>();

export interface PendingModelCall {
  span: Span;
  callId: string;
}

/** `runId:callId` → in-flight provider model-call span (started → ended pairing) */
export const modelCallSpans = new Map<string, PendingModelCall>();

/** Compose the stable key for a model-call span from its correlation ids. */
export function modelCallKey(runId: string, callId: string): string {
  return `${runId}::${callId}`;
}

/** Drop any in-flight tool spans for a session (called on `agent_end`). */
export function clearSessionArtifacts(sessionKey: string): void {
  toolStacks.delete(sessionKey);
}

/** Drop any leftover model-call spans for a finished run so nothing leaks. */
export function clearModelCallsForRun(runId: string): void {
  const prefix = `${runId}::`;
  for (const key of modelCallSpans.keys()) {
    if (key.startsWith(prefix)) modelCallSpans.delete(key);
  }
}
