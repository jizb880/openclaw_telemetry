import type { ObservabilityConfig } from "../config/observability.js";
import type { GlobalTracer } from "../tracer.js";
import { registerActionHooks } from "./action.js";
import { registerAgentRunHooks } from "./agent-run.js";
import { registerCompactionHooks } from "./compaction.js";
import { registerLlmHooks } from "./llm.js";
import { registerMessageHooks } from "./messages.js";
import { registerModelCallHooks } from "./model-call.js";
import { registerSessionHooks } from "./session.js";
import { registerToolHooks } from "./tool.js";

export type PluginRegistrationMode = "full" | "setup-only" | "setup-runtime";

export type OpenClawPluginApi = {
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** When not `"full"`, OpenClaw may skip heavy runtime wiring (see plugin SDK entrypoints). */
  registrationMode?: PluginRegistrationMode;
  on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void;
  registerService?: (svc: {
    id: string;
    start: () => void | Promise<void>;
    stop: () => void | Promise<void>;
  }) => void;
};

export function registerInterceptors(
  api: OpenClawPluginApi,
  gt: GlobalTracer,
  cfg: ObservabilityConfig
): void {
  // Order matters only for priority-tied hooks; each module sets its own priority.
  registerMessageHooks(api, gt, cfg);
  registerActionHooks(api, gt, cfg);
  registerAgentRunHooks(api, gt, cfg);
  registerToolHooks(api, gt, cfg);
  registerLlmHooks(api, gt, cfg);
  registerModelCallHooks(api, gt, cfg);
  registerSessionHooks(api, gt, cfg);
  registerCompactionHooks(api, gt, cfg);
}

export { registerActionHooks } from "./action.js";
export { registerAgentRunHooks } from "./agent-run.js";
export { registerCompactionHooks } from "./compaction.js";
export { registerMessageHooks } from "./messages.js";
export { registerModelCallHooks } from "./model-call.js";
export { registerSessionHooks } from "./session.js";
export { registerToolHooks } from "./tool.js";
export { registerLlmHooks, enrichAgentSpanForLlm } from "./llm.js";
