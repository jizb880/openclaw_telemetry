import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Inspect an exported OTLP/JSON NDJSON file and report which hooks were
 * captured. Used by the manual-test walkthrough in the README:
 *
 *   npm run inspect                       # default ./telemetry-out/openclaw-otel-spans.jsonl
 *   npm run inspect -- <path> [--json]
 *
 * Pure Node, no external tools — deliberately avoids `jq` so the documented
 * verification steps work on a bare Node install.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const DEFAULT_PATH = join("telemetry-out", "openclaw-otel-spans.jsonl");
const TOOL_SPAN_PREFIX = "openclaw.tool.";

interface CoverageEntry {
  hook: string;
  span: string;
}

/** Span names collected from the export, in first-seen order. */
function readSpanNames(file: string): { names: string[]; lines: number; bad: number } {
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return { names: [], lines: 0, bad: 0 };
  const names: string[] = [];
  const seen = new Set<string>();
  let bad = 0;
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    const req = parsed as {
      resourceSpans?: { scopeSpans?: { spans?: { name?: string }[] }[] }[];
    };
    for (const rs of req.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          const name = span?.name;
          if (typeof name !== "string" || seen.has(name)) continue;
          seen.add(name);
          names.push(name);
        }
      }
    }
  }
  return { names, lines: lines.filter((l) => l.trim()).length, bad };
}

function readExpectedSpans(): string[] {
  const coveragePath = join(repoRoot, "samples", "coverage.json");
  if (!existsSync(coveragePath)) return [];
  const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as { hooks?: CoverageEntry[] };
  return [...new Set((coverage.hooks ?? []).map((h) => h.span))];
}

/**
 * Tool spans are dynamic (`openclaw.tool.<name>`), so the representative entry
 * in coverage.json rarely matches the tool a real turn happened to call. Treat
 * any captured `openclaw.tool.*` as satisfying every expected tool span.
 */
function findMissing(expected: string[], captured: string[]): string[] {
  const got = new Set(captured);
  const hasAnyTool = captured.some((n) => n.startsWith(TOOL_SPAN_PREFIX));
  return expected.filter((name) => {
    if (got.has(name)) return false;
    if (name.startsWith(TOOL_SPAN_PREFIX) && hasAnyTool) return false;
    return true;
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const target = argv.find((a) => !a.startsWith("--")) ?? DEFAULT_PATH;

  if (!existsSync(target)) {
    if (asJson) {
      console.log(JSON.stringify({ ok: false, error: "not-found", file: target }, null, 2));
    } else {
      console.error(`✗ export file not found: ${target}`);
      console.error(
        "  Check that the plugin is loaded, enabled=true, otelSpanExportEnabled=true,",
      );
      console.error("  and that otelSpanExportPath points at a writable directory.");
    }
    process.exitCode = 1;
    return;
  }

  const { names, lines, bad } = readSpanNames(target);
  const expected = readExpectedSpans();
  const missing = findMissing(expected, names);
  const ok = missing.length === 0 && names.length > 0;

  if (asJson) {
    console.log(JSON.stringify({ ok, file: target, lines, captured: names, missing }, null, 2));
  } else {
    console.log(`file    ${target}`);
    console.log(`batches ${lines}${bad ? ` (${bad} unparsable line(s))` : ""}`);
    console.log(`spans   ${names.length} distinct`);
    console.log("");
    for (const name of [...names].sort()) console.log(`  ✓ ${name}`);
    console.log("");
    if (names.length === 0) {
      console.log("✗ no spans found — the export file is empty");
    } else if (missing.length === 0) {
      console.log(`✓ ALL COVERED — every expected hook span is present (${expected.length} expected)`);
    } else {
      console.log(`✗ MISSING ${missing.length} span(s):`);
      for (const name of missing.sort()) console.log(`  - ${name}`);
      console.log("");
      console.log("See the troubleshooting table in README section 3.2.");
    }
  }

  if (!ok) process.exitCode = 1;
}

main();
