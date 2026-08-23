#!/usr/bin/env node
/**
 * Personal AI OS CLI entrypoint.
 *
 * A thin launcher: the real subcommand logic lives in
 * src/lib/cli-runner.ts (TypeScript, typechecked). This file just resolves
 * the local tsx binary and hands off argv, so `aios` runs the same way
 * whether invoked via `node bin/aios.mjs ...` or the registered `aios` bin.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const tsxBin = resolve(pkgRoot, "node_modules", ".bin", "tsx");
const runnerPath = resolve(pkgRoot, "src", "lib", "cli-runner.ts");

if (!existsSync(runnerPath)) {
  console.error(`\n\x1b[31m\x1b[1m✖ ERROR:\x1b[0m CLI runner not found at ${runnerPath}`);
  console.error(`\x1b[36m\x1b[1m→ ACTION:\x1b[0m the forge-control checkout is incomplete or corrupted — reinstall it.\n`);
  process.exit(1);
}

if (!existsSync(tsxBin)) {
  console.error(`\n\x1b[31m\x1b[1m✖ ERROR:\x1b[0m tsx not found at ${tsxBin}`);
  console.error(
    `\x1b[36m\x1b[1m→ ACTION:\x1b[0m run 'pnpm install --frozen-lockfile --prod=false' in ${pkgRoot} (NODE_ENV=production silently skips devDependencies, which is where tsx lives).\n`,
  );
  process.exit(1);
}

const result = spawnSync(tsxBin, [runnerPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(`\n\x1b[31m\x1b[1m✖ ERROR:\x1b[0m failed to launch tsx: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 0);
