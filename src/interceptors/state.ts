import type { Context } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";

export interface SessionTraceState {
  rootSpan: Span;
  rootContext: Context;
  agentSpan?: Span;
  agentContext?: Context;
  startTime: number;
}

/** sessionKey → active request / agent trace */
export const sessionState = new Map<string, SessionTraceState>();

export interface PendingToolSpan {
  span: Span;
  toolName: string;
}

/** sessionKey → LIFO stack of in-flight tool spans (matches before/after order) */
export const toolStacks = new Map<string, PendingToolSpan[]>();
