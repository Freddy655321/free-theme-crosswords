import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const outDir = join(root, ".tmp-contract-tests");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(outDir, { recursive: true, force: true });
run("npx.cmd", ["tsc", "-p", "tsconfig.contract.json"]);

const scopedAlias = join(outDir, "node_modules", "@");
mkdirSync(scopedAlias, { recursive: true });
cpSync(join(outDir, "app"), join(scopedAlias, "app"), { recursive: true });
cpSync(join(outDir, "lib"), join(scopedAlias, "lib"), { recursive: true });

const serverOnlyDir = join(outDir, "node_modules", "server-only");
mkdirSync(serverOnlyDir, { recursive: true });
writeFileSync(join(serverOnlyDir, "index.js"), "\n", "utf8");
writeFileSync(
  join(serverOnlyDir, "package.json"),
  JSON.stringify({ name: "server-only", main: "index.js" }),
  "utf8"
);

if (!existsSync(join(outDir, "app", "api", "generate-crossword", "route.contract.test.js"))) {
  throw new Error("Compiled contract test was not found");
}

run("node", ["--test", join(outDir, "app", "api", "generate-crossword", "route.contract.test.js")]);
