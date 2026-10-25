#!/usr/bin/env bun
/**
 * One-shot codemod: erase every remaining `ngodeai` / `ngodeai` brand trace.
 *
 * Every rule is anchored on a word boundary (`\b`) or a path separator so that
 * ordinary English words — `prompt`, `component`, `compact`, `completion`,
 * `compare` — and the OpenMP standard variables (`OMP_NUM_THREADS`,
 * `OMP_THREAD_LIMIT`) are never touched. Longer, more specific tokens are
 * rewritten before the short ones they contain, so `ngodebot` can never degrade
 * into `robo-ngodeai`.
 *
 * Idempotent: running it twice changes nothing the second time.
 * Usage: bun scripts/purge-ngode-branding.ts [--dry-run]
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const dryRun = process.argv.includes("--dry-run");

/** Directories whose contents are generated, vendored, or third-party. */
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"dist-chrome",
	"dist-firefox",
	"target",
	"vendor",
	".turbo",
	"coverage",
	"binaries",
	".bazel",
	"bazel-out",
	"bazel-bin",
	"bazel-testlogs",
	"__pycache__",
	".venv",
	"verify-out",
	"data",
	"static",
]);

/** Generated artifacts that carry no source of truth. */
const SKIP_FILES = new Set(["MODULE.bazel.lock", "bun.lock", "Cargo.lock", "package-lock.json"]);

const BINARY_EXT = new Set([
	".webp",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".ico",
	".node",
	".wasm",
	".zst",
	".gz",
	".zip",
	".tgz",
	".sqlite",
	".db",
	".pdf",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".mp4",
	".webm",
	".svgz",
	".snap",
]);

/**
 * Ordered rewrites. `re` is global; order is load-bearing.
 * Every `re` uses `\b` so embedded substrings in unrelated words survive.
 */
const RULES: readonly { name: string; re: RegExp; to: string }[] = [
	// ---- 1. Compound product names -------------------------------------------
	{ name: "ngodebot", re: /\broboomp\b/gi, to: "ngodebot" },
	{ name: "ngodebot", re: /\brobomp\b/gi, to: "ngodebot" },
	{ name: "NGODEBOT_", re: /\bROBOMP_/g, to: "NGODEBOT_" },
	{ name: "ngodebot", re: /\bRobomp\b/g, to: "NgodeBot" },

	// ---- 2. RPC package/module names ----------------------------------------
	{ name: "ngodeairpc", re: /\bomprpc\b/gi, to: "ngodeairpc" },
	{ name: "ngodeai_rpc", re: /\bomp_rpc\b/g, to: "ngodeai_rpc" },
	{ name: "ngodeai-rpc", re: /\bomp-rpc\b/g, to: "ngodeai-rpc" },
	{ name: "ngodeairpc", re: /\bompRpc\b/g, to: "ngodeaiRpc" },
	{ name: "ngodeairpc", re: /\bOmpRpc\b/g, to: "NgodeaiRpc" },

	// ---- 3. Upstream project identity ---------------------------------------
	{ name: "ngodeai", re: /\boh[- ]my[- ]pi\b/gi, to: "ngodeai" },

	// ---- 4. Domains (specific host first) -----------------------------------
	{ name: "live.omp.sh", re: /\blive\.omp\.sh\b/g, to: "live.ngodeai.net" },
	{ name: "my.omp.sh", re: /\bmy\.omp\.sh\b/g, to: "my.ngodeai.net" },
	{ name: "skills.omp.sh", re: /\bskills\.omp\.sh\b/g, to: "skills.ngodeai.net" },
	{ name: "ngodeai.net", re: /\bomp\.sh\b/g, to: "ngodeai.net" },

	// ---- 5. Config paths -----------------------------------------------------
	{ name: "~/.omp", re: /~\/\.omp\b/g, to: "~/.ngodeai" },
	{ name: "$HOME/.omp", re: /\$HOME\/\.omp\b/g, to: "$HOME/.ngodeai" },
	{ name: "/.omp/", re: /\/\.omp\//g, to: "/.ngodeai/" },
	{ name: ".omp/", re: /(?<![\w.-])\.omp\//g, to: ".ngodeai/" },
	{ name: ".omp\\", re: /(?<![\w.-])\.omp\\/g, to: ".ngodeai\\" },
	{ name: '".omp"', re: /"\.omp"/g, to: '".ngodeai"' },
	{ name: "'.omp'", re: /'\.omp'/g, to: "'.ngodeai'" },
	{ name: "`omp`", re: /`omp`/g, to: "`ngodeai`" },

	// ---- 6. Type / class prefixes -------------------------------------------
	{ name: "NgodeTypeError", re: /\bOmpTypeError\b/g, to: "NgodeTypeError" },
	{ name: "NgodeTypeBuilder", re: /\bOmpTypeBuilder\b/g, to: "NgodeTypeBuilder" },
	{ name: "NgodeType", re: /\bOmpType\b/g, to: "NgodeType" },
	{ name: "NgodeErrors", re: /\bOmpErrors\b/g, to: "NgodeErrors" },
	{ name: "NgodeError", re: /\bOmpError\b/g, to: "NgodeError" },
	{ name: "NgodeMark", re: /\bOmpMark\b/g, to: "NgodeMark" },
	{ name: "NgodeLocal", re: /\bOmpLocal\b/g, to: "NgodeLocal" },
	{ name: "NgodeWorker", re: /\bOmpWorker\b/g, to: "NgodeWorker" },
	{ name: "NgodeDocEntry", re: /\bOmpDocEntry\b/g, to: "NgodeDocEntry" },
	{ name: "NgodeProtocolHandler", re: /\bOmpProtocolHandler\b/g, to: "NgodeProtocolHandler" },
	{ name: "NgodeToolViewElement", re: /\bOmpToolViewElement\b/g, to: "NgodeToolViewElement" },
	{ name: "NgodeExtensionRootMode", re: /\bOmpExtensionRootMode\b/g, to: "NgodeExtensionRootMode" },
	{ name: "NgodeExtensionRoot", re: /\bOmpExtensionRoot\b/g, to: "NgodeExtensionRoot" },
	{ name: "NgodeCommitInference", re: /\bOmpCommitInference\b/g, to: "NgodeCommitInference" },
	{ name: "NgodeAppleFm", re: /\bOmpAppleFm\b/g, to: "NgodeAppleFm" },
	{ name: "NgodeGenAIAggregateAttr", re: /\bOmpGenAIAggregateAttr\b/g, to: "NgodeGenAIAggregateAttr" },
	{ name: "NgodeGenAIAttr", re: /\bOmpGenAIAttr\b/g, to: "NgodeGenAIAttr" },

	// ---- 7. Env vars (before the bare token rule) ---------------------------
	// OpenMP standard names are protected by `protectOpenMP` before rules run.
	{ name: "OMP_", re: /\bOMP_/g, to: "NGODEAI_" },

	// ---- 8. Remaining identifiers -------------------------------------------
	{ name: "omp_", re: /\bomp_/g, to: "ngode_" },
	{ name: "omp-", re: /\bomp-/g, to: "ngode-" },
	{ name: "ngodePath", re: /\bompPath\b/g, to: "ngodePath" },
	{ name: "ompcast", re: /\bompcast\b/gi, to: "ngodecast" },
	{ name: "ompshare", re: /\bompshare\b/gi, to: "ngodeshare" },
	{ name: "omptype", re: /\bomptype\b/gi, to: "ngodetype" },
	{ name: "ngodeTui", re: /\bompTui\b/g, to: "ngodeTui" },
	{ name: "omp-tui", re: /\bomp-tui\b/g, to: "ngode-tui" },
	{ name: "omp-tests", re: /\bomp-tests\b/g, to: "ngode-tests" },
	{ name: "Omp", re: /\bOmp(?=[A-Z])/g, to: "Ngode" },
	{ name: "OMP", re: /\bOMP\b/g, to: "NGODEAI" },
	// Bare brand token last: every compound form above already consumed its
	// occurrence, so what is left is the product name on its own.
	{ name: "omp", re: /\bomp\b/g, to: "ngodeai" },
];

/**
 * OpenMP standard variables that must survive untouched. Only the two this repo
 * actually reads (`crates/ngode-builtins/src/nproc.rs`, mirroring GNU `nproc`)
 * are listed — every other `NGODEAI_*` name in the tree is NgodeAI's own and gets
 * rewritten. `NGODEAI_PROFILE` is deliberately absent: it is our legacy profile
 * selector, not the OpenMP tooling variable of the same spelling.
 */
const OPENMP_ALLOWLIST = ["OMP_NUM_THREADS", "OMP_THREAD_LIMIT"];

function isTextFile(file: string): boolean {
	return !BINARY_EXT.has(path.extname(file).toLowerCase());
}

async function* walk(dir: string): AsyncGenerator<string> {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			yield* walk(path.join(dir, entry.name));
		} else if (entry.isFile()) {
			yield path.join(dir, entry.name);
		}
	}
}

const KEEP_OPEN = "\u0000OPENMP";

function protectOpenMP(text: string): { text: string; restore: (s: string) => string } {
	const saved: string[] = [];
	let out = text;
	for (const name of OPENMP_ALLOWLIST) {
		if (!out.includes(name)) continue;
		const token = `${KEEP_OPEN}${saved.length}\u0000`;
		saved.push(name);
		out = out.split(name).join(token);
	}
	return {
		text: out,
		restore: (s: string) => {
			let restored = s;
			for (let i = 0; i < saved.length; i++) restored = restored.split(`${KEEP_OPEN}${i}\u0000`).join(saved[i]);
			return restored;
		},
	};
}

function rewrite(raw: string): string {
	const { text, restore } = protectOpenMP(raw);
	let out = text;
	for (const rule of RULES) out = out.replace(rule.re, rule.to);
	return restore(out);
}

async function main(): Promise<void> {
	const stats = new Map<string, { files: number; hits: number }>();
	let scanned = 0;
	const changedFiles: string[] = [];

	for await (const file of walk(repoRoot)) {
		// The codemod is the one file whose own rule table spells the old brand;
		// rewriting it would neuter every subsequent rule.
		if (file === import.meta.path) continue;
		if (SKIP_FILES.has(path.basename(file))) continue;
		if (!isTextFile(file)) continue;
		scanned++;
		let content: string;
		try {
			content = await fs.readFile(file, "utf8");
		} catch {
			continue;
		}
		if (!/ngodeai/i.test(content)) continue;
		const next = rewrite(content);
		if (next === content) continue;
		changedFiles.push(path.relative(repoRoot, file));
		for (const rule of RULES) {
			const matches = content.match(rule.re);
			if (!matches) continue;
			const cur = stats.get(rule.name) ?? { files: 0, hits: 0 };
			cur.files += 1;
			cur.hits += matches.length;
			stats.set(rule.name, cur);
		}
		if (!dryRun) await fs.writeFile(file, next, "utf8");
	}

	console.log(`${dryRun ? "DRY RUN — " : ""}scanned ${scanned} text files, ${changedFiles.length} rewritten\n`);
	for (const [name, s] of [...stats.entries()].sort((a, b) => b[1].hits - a[1].hits)) {
		console.log(`  ${String(s.hits).padStart(6)}×  ${name.padEnd(22)} in ${s.files} file(s)`);
	}
}

await main();
