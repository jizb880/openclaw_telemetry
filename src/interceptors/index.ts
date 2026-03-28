import type { ObservabilityConfig } from "../config/observability.js";
import type { GlobalTracer } from "../tracer.js";
import { registerActionHooks } from "./action.js";
import { registerLlmHooks } from "./llm.js";
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
  registerActionHooks(api, gt, cfg);
  registerToolHooks(api, gt, cfg);
  registerLlmHooks(api, gt, cfg);
}

export { registerActionHooks } from "./action.js";
export { registerToolHooks } from "./tool.js";
export { registerLlmHooks, enrichAgentSpanForLlm } from "./llm.js";
