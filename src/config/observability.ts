import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ObservabilityConfig {
  enabled: boolean;
  serviceName: string;
  /** Full OTLP HTTP traces URL, e.g. http://localhost:4318/v1/traces */
  otlpEndpoint: string;
  /** When false, skip the OTLP HTTP exporter entirely (NDJSON-only mode). Useful for offline/local runs. */
  otlpEnabled: boolean;
  /** When true, append OTLP span batches as NDJSON lines to a local file (see `otelSpanExportPath`). */
  otelSpanExportEnabled: boolean;
  /**
   * Directory or `.jsonl` file path. If a directory (default `.`), writes `openclaw-otel-spans.jsonl` under it.
   * If the string ends with `.jsonl`, it is treated as the full file path (relative to cwd unless absolute).
   */
  otelSpanExportPath: string;
  captureAction: boolean;
  /** Inbound/outbound message hooks (`message_received`, `message_sent`) */
  captureMessages: boolean;
  /** Outbound rewrite/cancel hook (`message_sending`) */
  captureMessageSending: boolean;
  captureTool: boolean;
  captureLlm: boolean;
  captureLlmInput: boolean;
  captureLlmOutput: boolean;
  captureToolInput: boolean;
  captureToolOutput: boolean;
  /** Input gate hook (`before_agent_run`; legacy `before_agent_start` fallback) */
  captureAgentRun: boolean;
  /** Provider-call telemetry (`model_call_started` / `model_call_ended`); sanitized, no prompt/response */
  captureModelCall: boolean;
  /** Tool-result persistence hook (`tool_result_persist`; host ≥ 2026.7) */
  captureToolResultPersist: boolean;
  /** Session lifecycle hooks (`session_start` / `session_end`) */
  captureSession: boolean;
  /** Context compaction hooks (`before_compaction` / `after_compaction`, legacy `*_context_prune`) */
  captureCompaction: boolean;
}

const defaults: ObservabilityConfig = {
  enabled: true,
  serviceName: "openclaw",
  otlpEndpoint: "http://localhost:4318/v1/traces",
  otlpEnabled: true,
  otelSpanExportEnabled: true,
  otelSpanExportPath: ".",
  captureAction: true,
  captureMessages: true,
  captureMessageSending: true,
  captureTool: true,
  captureLlm: true,
  captureLlmInput: true,
  captureLlmOutput: true,
  captureToolInput: true,
  captureToolOutput: true,
  captureAgentRun: true,
  captureModelCall: true,
  captureToolResultPersist: true,
  captureSession: true,
  captureCompaction: true,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asStr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** Merge file JSON with defaults; invalid keys are ignored. */
export function parseObservabilityConfig(raw: unknown): ObservabilityConfig {
  if (!isRecord(raw)) return { ...defaults };
  return {
    enabled: asBool(raw.enabled, defaults.enabled),
    serviceName: asStr(raw.serviceName, defaults.serviceName),
    otlpEndpoint: asStr(raw.otlpEndpoint, defaults.otlpEndpoint),
    otlpEnabled: asBool(raw.otlpEnabled, defaults.otlpEnabled),
    otelSpanExportEnabled: asBool(raw.otelSpanExportEnabled, defaults.otelSpanExportEnabled),
    otelSpanExportPath: asStr(raw.otelSpanExportPath, defaults.otelSpanExportPath),
    captureAction: asBool(raw.captureAction, defaults.captureAction),
    captureMessages: asBool(raw.captureMessages, defaults.captureMessages),
    captureMessageSending: asBool(raw.captureMessageSending, defaults.captureMessageSending),
    captureTool: asBool(raw.captureTool, defaults.captureTool),
    captureLlm: asBool(raw.captureLlm, defaults.captureLlm),
    captureLlmInput: asBool(raw.captureLlmInput, defaults.captureLlmInput),
    captureLlmOutput: asBool(raw.captureLlmOutput, defaults.captureLlmOutput),
    captureToolInput: asBool(raw.captureToolInput, defaults.captureToolInput),
    captureToolOutput: asBool(raw.captureToolOutput, defaults.captureToolOutput),
    captureAgentRun: asBool(raw.captureAgentRun, defaults.captureAgentRun),
    captureModelCall: asBool(raw.captureModelCall, defaults.captureModelCall),
    captureToolResultPersist: asBool(raw.captureToolResultPersist, defaults.captureToolResultPersist),
    captureSession: asBool(raw.captureSession, defaults.captureSession),
    captureCompaction: asBool(raw.captureCompaction, defaults.captureCompaction),
  };
}

/** Resolved absolute path for NDJSON span export, or null when disabled. */
export function resolveOtelSpanExportFilePath(cfg: ObservabilityConfig): string | null {
  if (!cfg.otelSpanExportEnabled) return null;
  const raw = cfg.otelSpanExportPath.trim() || ".";
  if (/\.jsonl$/i.test(raw)) {
    return resolve(process.cwd(), raw);
  }
  return join(resolve(process.cwd(), raw), "openclaw-otel-spans.jsonl");
}

/**
 * Load `config/observability.json` from cwd, or `OBSERVABILITY_CONFIG` absolute path.
 */
export function loadObservabilityConfig(
  explicitPath?: string
): ObservabilityConfig {
  const fromEnv = process.env.OBSERVABILITY_CONFIG?.trim();
  const pathToRead = explicitPath ?? fromEnv ?? resolve(process.cwd(), "config", "observability.json");
  if (!existsSync(pathToRead)) {
    return { ...defaults };
  }
  const text = readFileSync(pathToRead, "utf8");
  const parsed: unknown = JSON.parse(text);
  return parseObservabilityConfig(parsed);
}
