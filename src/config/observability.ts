import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface ObservabilityConfig {
  enabled: boolean;
  serviceName: string;
  /** Full OTLP HTTP traces URL, e.g. http://localhost:4318/v1/traces */
  otlpEndpoint: string;
  captureAction: boolean;
  captureTool: boolean;
  captureLlm: boolean;
  captureLlmInput: boolean;
  captureLlmOutput: boolean;
  captureToolInput: boolean;
  captureToolOutput: boolean;
}

const defaults: ObservabilityConfig = {
  enabled: true,
  serviceName: "openclaw",
  otlpEndpoint: "http://localhost:4318/v1/traces",
  captureAction: true,
  captureTool: true,
  captureLlm: true,
  captureLlmInput: true,
  captureLlmOutput: true,
  captureToolInput: true,
  captureToolOutput: true,
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
    captureAction: asBool(raw.captureAction, defaults.captureAction),
    captureTool: asBool(raw.captureTool, defaults.captureTool),
    captureLlm: asBool(raw.captureLlm, defaults.captureLlm),
    captureLlmInput: asBool(raw.captureLlmInput, defaults.captureLlmInput),
    captureLlmOutput: asBool(raw.captureLlmOutput, defaults.captureLlmOutput),
    captureToolInput: asBool(raw.captureToolInput, defaults.captureToolInput),
    captureToolOutput: asBool(raw.captureToolOutput, defaults.captureToolOutput),
  };
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
