import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error("Usage: npm run feasibility -- <capture.json> <artifact-directory>");
const out = resolve(output);
if (existsSync(join(out, "started.json"))) throw Error("Refusing repeated solve");
const compile = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc", "-p", "tsconfig.contract.json"], { stdio: "inherit", shell: process.platform === "win32" });
if (compile.status !== 0) process.exit(compile.status ?? 1);
const compiled = resolve(".tmp-contract-tests");
const aliases = join(compiled, "node_modules", "@");
mkdirSync(aliases, { recursive: true });
cpSync(join(compiled, "app"), join(aliases, "app"), { recursive: true });
const child = spawnSync(process.execPath, [join(compiled, "scripts", "exact-structural-feasibility.js"), resolve(input), out], { stdio: "inherit", timeout: 300_000 });
// Five-minute whole-process watchdog allows model construction plus the fixed
// three-minute native timeout. Interruption can only produce INCONCLUSIVE.
if (child.error || child.signal || child.status !== 0) {
  const file = join(out, "result.json");
  if (existsSync(file)) {
    const result = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...result, status: "INCONCLUSIVE", processFailure: child.error?.message ?? child.signal ?? child.status }, null, 2));
  }
  process.exit(1);
}
