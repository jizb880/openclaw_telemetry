import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regenerate `test/fixtures/host-hook-names.json` from the OpenClaw host
 * installed on this machine. Run after upgrading the host:
 *
 *   npm run sync:host-hooks
 *
 * The fixture lets the E2E suite verify hook completeness even where the host
 * is not installed (CI). When the host IS installed, a test cross-checks the
 * fixture against the live definitions so drift is caught.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

function findHostDir(): string | undefined {
  const candidates = [
    `${process.env.HOME}/.npm-global/lib/node_modules/openclaw`,
    join(repoRoot, "node_modules", "openclaw"),
    "/usr/local/lib/node_modules/openclaw",
    "/opt/homebrew/lib/node_modules/openclaw",
  ];
  return candidates.find((c) => existsSync(c));
}

function findHookTypesFile(distDir: string): string | undefined {
  if (!existsSync(distDir)) return undefined;
  const match = readdirSync(distDir).find((f) => /^hook-types-.*\.d\.ts$/.test(f));
  return match ? join(distDir, match) : undefined;
}

function extractList(src: string, name: string): string[] {
  const m = src.match(new RegExp(`declare const ${name}: readonly \\[([^\\]]+)\\]`));
  if (!m) throw new Error(`could not find ${name} in host hook types`);
  return m[1]
    .split(",")
    .map((x) => x.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function main(): void {
  const hostDir = findHostDir();
  if (!hostDir) {
    console.error("Could not find an installed OpenClaw host. Install it or set it up first.");
    process.exit(1);
  }
  const typesFile = findHookTypesFile(join(hostDir, "dist"));
  if (!typesFile) {
    console.error(`Could not find hook-types-*.d.ts under ${hostDir}/dist`);
    process.exit(1);
  }

  const src = readFileSync(typesFile, "utf8");
  const version = JSON.parse(readFileSync(join(hostDir, "package.json"), "utf8")).version as string;

  const out = {
    _comment: "Vendored from the installed OpenClaw host. Regenerate with: npm run sync:host-hooks",
    hostVersion: version,
    pluginHookNames: extractList(src, "PLUGIN_HOOK_NAMES"),
    conversationHookNames: extractList(src, "CONVERSATION_HOOK_NAMES"),
  };

  const dest = join(repoRoot, "test", "fixtures", "host-hook-names.json");
  writeFileSync(dest, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(
    `Synced ${out.pluginHookNames.length} hook names (host ${version}) → test/fixtures/host-hook-names.json`
  );
}

main();
