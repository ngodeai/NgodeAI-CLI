#!/usr/bin/env bun
/**
 * Guards the NgodeAI tree against upstream (`omp` / `oh-my-pi`) brand traces.
 *
 * The fork is synced incrementally from upstream, so every sync can reintroduce
 * upstream names. This check is the gate: it scans tracked files for brand
 * tokens and fails on any hit that is not an explicitly reasoned exception.
 *
 * Usage:
 *   bun scripts/check-branding.ts           # report and fail on violations
 *   bun scripts/check-branding.ts --list    # print the exception table only
 *
 * Adding an exception is a deliberate act: it needs a `reason` that explains
 * why the token must stay byte-identical (external protocol key, legal notice,
 * captured fixture, or a migration path for pre-rebrand installs).
 */

import * as path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..");

/** Generated, vendored, or third-party paths with no NgodeAI-authored text. */
const SKIP_PATHS: readonly string[] = [
	"THIRD-PARTY-NOTICES.txt",
	"bun.lock",
	"Cargo.lock",
	"MODULE.bazel.lock",
	"packages/coding-agent/test/fixtures/large-session.jsonl",
	"packages/ai/test/fixtures/harmony-leak-corpus.json",
	"crates/ngode-natives/src/utok/claude/testdata/fixtures.json",
];

/** Directory prefixes that are vendored, build output, or local reports. */
const SKIP_PREFIXES: readonly string[] = ["crates/vendor/", "node_modules/", "target/", "bazel-", ".vibe-reports/"];

/** Binary or compressed assets that cannot carry a brand token. */
const SKIP_EXTENSIONS: readonly string[] = [
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".node",
	".wasm",
	".zst",
	".gz",
	".zip",
	".tgz",
	".pdf",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".mp4",
	".webm",
	".bin",
	".sqlite",
	".db",
];

interface Rule {
	/** Short label used in the report. */
	name: string;
	/** Pattern whose matches are brand traces. */
	re: RegExp;
	/** What a match means, printed once per hit. */
	hint: string;
}

/**
 * Order is irrelevant; every rule runs on every line. Patterns are anchored on
 * word boundaries or explicit separators so English words that merely contain
 * the letters (`prompt`, `compact`, `completion`) never match.
 */
const RULES: readonly Rule[] = [
	{
		name: "upstream-product",
		re: /\boh[-_ ]?my[-_ ]?pi\b/i,
		hint: "upstream product name; use NgodeAI",
	},
	{
		name: "brand-word",
		re: /(?<![\w-])omp(?![\w-])/i,
		hint: "upstream brand token; use NgodeAI or a neutral word",
	},
	{
		name: "brand-identifier",
		re: /(?<![\w-])(omp[A-Z_]\w*|__omp\w*)/,
		hint: "upstream identifier prefix; rename to the ngode equivalent",
	},
	{
		name: "brand-path",
		re: /(?<![\w-])\.omp(?![\w-])|(?<![\w-])omp\.sh\b|\bomp\//,
		hint: "upstream config path or domain; use .ngodeai / ngodeai.net",
	},
	{
		name: "brand-package",
		re: /@oh-my-pi\//,
		hint: "upstream npm scope; use @ngodeai/",
	},
	{
		name: "stale-repo",
		re: /can1357\/(oh-my-pi|ngodeai)/,
		hint: "upstream repo path; use ngodeai/NgodeAI-CLI",
	},
];

interface Exception {
	/** Exact repo-relative path. */
	file: string;
	/** Rule name the exception applies to; `"*"` covers every rule for that file. */
	rule: string;
	/** Why the token cannot be renamed. */
	reason: string;
}

/** Each entry is a reviewed decision, not a suppression. */
const EXCEPTIONS: readonly Exception[] = [
	{
		file: "docs/upstream-sync.md",
		rule: "*",
		reason: "the sync guide must name the upstream project, repo, and config root to be usable",
	},
	{
		file: "README.md",
		rule: "upstream-product",
		reason: "MIT attribution: the upstream project and authors must be credited",
	},
	{
		file: "README.md",
		rule: "brand-word",
		reason: "MIT attribution: the upstream project and authors must be credited",
	},
	{
		file: "README.md",
		rule: "stale-repo",
		reason: "MIT attribution: the link must point at the actual upstream repository",
	},
	{
		file: "docs/models.md",
		rule: "brand-identifier",
		reason: "documents the gateway wire key __omp_judgment_images defined in systemone.ts",
	},
	{
		file: "packages/utils/src/dirs.ts",
		rule: "brand-path",
		reason: 'legacy config root ".omp" is migrated into ".ngodeai"; renaming it orphans existing installs',
	},
	{
		file: "packages/utils/src/dirs.ts",
		rule: "brand-word",
		reason: 'legacy config root ".omp" is migrated into ".ngodeai"; renaming it orphans existing installs',
	},
	{
		file: "crates/ngode-builtins/src/nproc.rs",
		rule: "brand-identifier",
		reason: "OMP_NUM_THREADS / OMP_THREAD_LIMIT are OpenMP, not the upstream brand",
	},
	{
		file: "packages/ai/src/judgment/systemone.ts",
		rule: "brand-identifier",
		reason: "gateway wire key __omp_judgment_images is part of the deployed request contract",
	},
];

interface Violation {
	file: string;
	line: number;
	rule: string;
	hint: string;
	text: string;
}

function isSkipped(file: string): boolean {
	if (SKIP_PATHS.includes(file)) return true;
	if (SKIP_PREFIXES.some(prefix => file.startsWith(prefix))) return true;
	return SKIP_EXTENSIONS.some(ext => file.endsWith(ext));
}

/** Tracked files only: untracked scratch files are not shipped. */
async function listTrackedFiles(): Promise<string[]> {
	const proc = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPO_ROOT });
	if (proc.exitCode !== 0) {
		throw new Error(`git ls-files failed: ${proc.stderr.toString()}`);
	}
	return proc.stdout
		.toString()
		.split("\0")
		.filter(file => file.length > 0);
}

/**
 * Test files mirror production tokens; an exception on a source file covers its
 * tests. `rule: "*"` exempts every rule for that exact file.
 */
function exceptionFor(file: string, rule: string): Exception | undefined {
	const direct = EXCEPTIONS.find(entry => entry.file === file && (entry.rule === rule || entry.rule === "*"));
	if (direct) return direct;
	const testDir = file.indexOf("/test/");
	if (testDir < 0) return undefined;
	const sourcePrefix = file.slice(0, testDir);
	return EXCEPTIONS.find(
		entry =>
			(entry.rule === rule || entry.rule === "*") &&
			entry.file.startsWith(sourcePrefix) &&
			!entry.file.includes("/test/"),
	);
}

/** Fast reject: no brand token can match a file/line without one of these. */
const BRAND_PREFILTER = /omp|my[-_ ]?pi/i;

async function scanFile(file: string): Promise<Violation[]> {
	const absolute = path.join(REPO_ROOT, file);
	let text: string;
	try {
		text = await Bun.file(absolute).text();
	} catch {
		return [];
	}
	// Cheap reject before the per-line pass: most files carry no brand token.
	if (!BRAND_PREFILTER.test(text)) return [];

	const violations: Violation[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (!BRAND_PREFILTER.test(line)) continue;
		for (const rule of RULES) {
			rule.re.lastIndex = 0;
			if (!rule.re.test(line)) continue;
			if (exceptionFor(file, rule.name)) continue;
			violations.push({
				file,
				line: index + 1,
				rule: rule.name,
				hint: rule.hint,
				text: line.trim().slice(0, 200),
			});
		}
	}
	return violations;
}

async function run() {
	if (process.argv.includes("--list")) {
		for (const entry of EXCEPTIONS) {
			console.log(`${entry.file}\t${entry.rule}\t${entry.reason}`);
		}
		return;
	}

	const files = (await listTrackedFiles()).filter(file => !isSkipped(file));
	const batches: Violation[][] = [];
	const BATCH_SIZE = 64;
	for (let start = 0; start < files.length; start += BATCH_SIZE) {
		batches.push(await Promise.all(files.slice(start, start + BATCH_SIZE).map(scanFile)).then(r => r.flat()));
	}
	const violations = batches.flat();

	for (const violation of violations) {
		console.error(`${violation.file}:${violation.line} [${violation.rule}] ${violation.hint}`);
		console.error(`    ${violation.text}`);
	}

	if (violations.length === 0) {
		console.log(`[OK]   no upstream brand traces in ${files.length} tracked files`);
		return;
	}

	const affected = new Set(violations.map(violation => violation.file)).size;
	console.error(
		`\n[FAIL] ${violations.length} upstream brand trace(s) in ${affected} file(s).` +
			"\nRename them, or add a reviewed exception in scripts/check-branding.ts (`--list` shows the table).",
	);
	process.exit(1);
}

run();
