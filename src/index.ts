import { loadObservabilityConfig } from "./config/observability.js";
import { registerInterceptors, type OpenClawPluginApi } from "./interceptors/index.js";
import { GlobalTracer } from "./tracer.js";

const plugin = {
  id: "openclaw-otel-observability",
  name: "OpenTelemetry Observability",
  description: "OpenClaw Action, Tool, and LLM tracing via OpenTelemetry (OTLP)",
  register(api: OpenClawPluginApi) {
    const config = loadObservabilityConfig();
    const logger = api.logger;

    if (api.registrationMode !== undefined && api.registrationMode !== "full") {
      logger?.info?.(`[otel] Skipped (registrationMode=${api.registrationMode})`);
      return;
    }

    if (!config.enabled) {
      logger?.info?.("[otel] Disabled (config.enabled=false)");
      return;
    }

    const tracer = GlobalTracer.getInstance();
    tracer.init(config);

    registerInterceptors(api, tracer, config);

    api.registerService?.({
      id: "openclaw-otel-observability",
      start: async () => {
        logger?.info?.("[otel] Tracing active → " + config.otlpEndpoint);
      },
      stop: async () => {
        await tracer.shutdown();
        logger?.info?.("[otel] Shutdown complete");
      },
    });
  },
};

export default plugin;

export { GlobalTracer } from "./tracer.js";
export {
  loadObservabilityConfig,
  parseObservabilityConfig,
  type ObservabilityConfig,
} from "./config/observability.js";
export {
  registerInterceptors,
  registerActionHooks,
  registerToolHooks,
  registerLlmHooks,
  enrichAgentSpanForLlm,
} from "./interceptors/index.js";
