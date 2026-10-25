#!/usr/bin/env bun
/**
 * Run the CLI against a throwaway HOME so first-run onboarding behaves exactly
 * as it does on a fresh machine — without touching your real `~/.ngodeai` or
 * the pre-rebrand `~/.omp`.
 *
 * Usage:
 *   bun scripts/review.ts            # fresh HOME, onboarding runs
 *   bun scripts/review.ts --keep     # reuse the sandbox from a previous run
 *   bun scripts/review.ts --reset    # wipe the sandbox first
 *   bun scripts/review.ts -- <args>  # extra CLI args (after the `--`)
 *
 * The sandbox lives in `.review-home/` (git-ignored). Delete it any time; it
 * holds nothing you need.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");
const sandbox = path.join(repoRoot, ".review-home");
const argv = process.argv.slice(2);

// Bun strips a bare `--` before argv reaches the script, so treat every
// non-flag token as a CLI argument instead of relying on the separator.
const OWN_FLAGS = new Set(["--reset", "--keep"]);
const reset = argv.includes("--reset");
const keep = argv.includes("--keep");
const extra = argv.filter(token => !OWN_FLAGS.has(token));

if (reset) {
	fs.rmSync(sandbox, { recursive: true, force: true });
	console.log(`wiped ${path.relative(repoRoot, sandbox)}`);
} else if (!keep && fs.existsSync(sandbox)) {
	// A stale sandbox would skip onboarding, which is the thing being reviewed.
	fs.rmSync(sandbox, { recursive: true, force: true });
}
fs.mkdirSync(sandbox, { recursive: true });

// Point every HOME-ish variable at the sandbox. The CLI reads USERPROFILE on
// Windows and HOME elsewhere, and both are consulted by the config resolver.
const env = {
	...process.env,
	HOME: sandbox,
	USERPROFILE: sandbox,
	HOMEDRIVE: path.parse(sandbox).root.replace(/\\$/, ""),
	HOMEPATH: sandbox.slice(path.parse(sandbox).root.length - 1),
	// Never let a real key from the parent shell satisfy the onboarding gate.
	NGODEAI_API_KEY: "",
	// Terminal capability probes are noisy in a review run.
	NGODEAI_SKIP_SETUP: "",
};

console.log(`sandbox: ${path.relative(repoRoot, sandbox)}`);
console.log(`running: bun packages/coding-agent/src/cli.ts ${extra.join(" ")}\n`);

// Build the command explicitly so `-- config path` reaches the CLI as two
// separate arguments rather than being swallowed by the shell template.
const cmd = ["bun", "packages/coding-agent/src/cli.ts", ...extra];
const result = await Bun.spawn(cmd, {
	cwd: repoRoot,
	env,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
}).exited;
process.exit(result.exitCode ?? 0);
