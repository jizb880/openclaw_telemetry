import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the project's zero-dependency contract:
 *   1. no runtime npm dependencies — only Node built-ins,
 *   2. no shelling out to external CLI tools (`jq`, `curl`, ...),
 *   3. no documented command that relies on such a tool.
 *
 * These are load-bearing promises in the README's verification walkthrough:
 * a reader with a bare Node install must be able to follow every step.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

function sourceFiles(...dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extname(full) === ".ts") out.push(full);
    }
  };
  for (const d of dirs) walk(join(repoRoot, d));
  return out;
}

describe("no external dependencies", () => {
  it("declares no runtime npm dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      assert.deepEqual(
        Object.keys(pkg[field] ?? {}),
        [],
        `${field} must stay empty — the plugin ships on Node built-ins only`,
      );
    }
  });

  it("imports only node: built-ins and relative paths", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src", "scripts", "test")) {
      const text = readFileSync(file, "utf8");
      // Anchored to statement starts so the word "from" inside ordinary
      // expressions or string literals is not mistaken for an import.
      const specs = [
        // import ... from "x" / export {...} from "x" — the clause may wrap
        // across lines, but never past its closing brace.
        ...text.matchAll(/^\s*import\s+(?:[\w*$]|\{[^}]*\})[^;]*?from\s*"([^"]+)"/gm),
        ...text.matchAll(/^\s*export\s+(?:\*|\{[^}]*\})\s*from\s*"([^"]+)"/gm),
        // bare side-effect import, dynamic import, require
        ...text.matchAll(/^\s*import\s*"([^"]+)"/gm),
        ...text.matchAll(/\bimport\s*\(\s*"([^"]+)"/g),
        ...text.matchAll(/\brequire\s*\(\s*"([^"]+)"/g),
      ];
      for (const m of specs) {
        const spec = m[1];
        if (spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("/")) continue;
        offenders.push(`${file.slice(repoRoot.length + 1)} -> ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `bare-module imports are not allowed: ${offenders.join(", ")}`);
  });

  it("never spawns a subprocess", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src", "scripts")) {
      const text = readFileSync(file, "utf8");
      if (/child_process|execSync|spawnSync|execFile/.test(text)) {
        offenders.push(file.slice(repoRoot.length + 1));
      }
    }
    assert.deepEqual(offenders, [], "shipped code must not shell out");
  });

  it("documents no command that needs an external tool", () => {
    // Matches a shell invocation of the tool, not prose that merely names it
    // (the READMEs legitimately say "no `jq` required").
    const forbidden = /(^|[|&;(]\s*|\$\(\s*)(jq|yq|curl|wget|python3?|docker|awk|perl)\s+-?\S/m;
    const offenders: string[] = [];
    for (const doc of ["README.md", "README.en.md", "README.zh-CN.md", "ARCHITECTURE.md"]) {
      let text: string;
      try {
        text = readFileSync(join(repoRoot, doc), "utf8");
      } catch {
        continue;
      }
      for (const block of text.matchAll(/```(?:bash|sh|shell|console)\n([\s\S]*?)```/g)) {
        for (const line of block[1].split("\n")) {
          const code = line.replace(/#.*$/, "").trim();
          if (code && forbidden.test(code)) offenders.push(`${doc}: ${code}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `documented shell commands must be pure Node: ${offenders.join(" | ")}`,
    );
  });

  it("documents only npm scripts that exist", () => {
    const scripts = Object.keys(
      (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: object })
        .scripts,
    );
    const missing: string[] = [];
    for (const doc of ["README.md", "README.en.md"]) {
      const text = readFileSync(join(repoRoot, doc), "utf8");
      for (const m of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
        if (!scripts.includes(m[1])) missing.push(`${doc} -> ${m[1]}`);
      }
    }
    assert.deepEqual(missing, [], `documented scripts not in package.json: ${missing.join(", ")}`);
  });
});
