/**
 * User-defined decision points.
 *
 * A decision point is a named question set plus the thresholds its answers are
 * held to. The built-in points are compiled in, because the agent calls them
 * from code. A *user* point is declared in a JSON file, so a project can add a
 * gate without forking the CLI — and, more importantly, so the criteria that
 * define a judgment can be reviewed and versioned next to the code they judge.
 *
 * ```text
 * .ngodeai/decisions/release-ready.json
 * {
 *   "label": "Release readiness",
 *   "risk": "write",
 *   "autoThreshold": 0.9,
 *   "questions": {
 *     "changelog": {
 *       "instructions": "Does `state.changelog` describe every user-visible change in `state.diff`?"
 *     },
 *     "tests": {
 *       "instructions": "How well do the tests in `state.diff` cover the changed behavior?",
 *       "criteria": ["no coverage", "partial", "covers the change"]
 *     }
 *   }
 * }
 * ```
 *
 * Two rules make these safe to load:
 *
 * - A file is validated before it is used. A malformed point is reported and
 *   skipped, never half-applied: a gate with a missing question would answer
 *   `undefined` and read as confident.
 * - A file cannot widen a threshold. `autoThreshold` may only make a point
 *   stricter than its risk class allows; an `irreversible` point still never
 *   auto-approves, whatever the file says.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { judgeQuestions, type QuestionFile, type Questions } from "@ngodeai/ai";
import { logger } from "@ngodeai/utils";
import type { DecisionRisk } from "@ngodeai/ai";

/** A decision point declared in a project or user file. */
export interface UserDecisionPoint {
	/** Stable id: the file's basename without `.json`. */
	id: string;
	/** Human label for `/decisions`; falls back to {@link id}. */
	label?: string;
	/** One sentence on what the answer changes. */
	description?: string;
	/** Risk class of the action the answer authorizes. */
	risk: DecisionRisk;
	/** Confidence at which code may act without asking. Never above the class's ceiling. */
	autoThreshold?: number;
	/** The questions, already typed from the file's criteria shapes. */
	questions: Questions;
	/** Where the point was loaded from, for diagnostics. */
	source: string;
}

/** What a JSON file may declare. */
interface DecisionFileSpec {
	label?: string;
	description?: string;
	risk?: string;
	autoThreshold?: number;
	questions?: QuestionFile;
}

/** Where user decision points are looked up, most specific first. */
export interface DecisionPointPaths {
	/** Project directory, usually the session root. */
	cwd?: string;
	/** User config directory, usually `~/.ngodeai`. */
	agentDir?: string;
}

const RISK_CLASSES: ReadonlySet<string> = new Set(["read", "write", "irreversible"]);

/** `read`, `write`, `irreversible` from an untrusted value; `read` when absent, never a guess upward. */
function parseRisk(value: unknown): DecisionRisk {
	if (typeof value !== "string") return "read";
	return RISK_CLASSES.has(value) ? (value as DecisionRisk) : "read";
}

/**
 * Validate one file's contents into a point.
 *
 * @throws when the file has no questions, a question is malformed, or the
 * threshold is not a probability. A caller loading many files catches per file
 * so one bad point cannot hide the rest.
 */
export function parseDecisionPoint(id: string, raw: unknown, source: string): UserDecisionPoint {
	if (typeof raw !== "object" || raw === null) throw new Error(`${id}: expected a JSON object`);
	const spec = raw as DecisionFileSpec;
	if (typeof spec.questions !== "object" || spec.questions === null) {
		throw new Error(`${id}: "questions" must be an object`);
	}
	const ids = Object.keys(spec.questions);
	if (ids.length === 0) throw new Error(`${id}: "questions" must declare at least one question`);

	// `judgeQuestions` is the same derivation the built-ins use: a criteria array
	// is a score, a `true`/`false` rubric is a noul, any other label map is a
	// choice, and no criteria is a noul. Reusing it keeps one definition of what
	// a question file means.
	let questions: Questions;
	try {
		questions = judgeQuestions(spec.questions);
	} catch (error) {
		throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const point: UserDecisionPoint = {
		id,
		risk: parseRisk(spec.risk),
		questions,
		source,
	};
	if (typeof spec.label === "string" && spec.label.trim().length > 0) point.label = spec.label.trim();
	if (typeof spec.description === "string" && spec.description.trim().length > 0) {
		point.description = spec.description.trim();
	}
	if (spec.autoThreshold !== undefined) {
		if (
			typeof spec.autoThreshold !== "number" ||
			!Number.isFinite(spec.autoThreshold) ||
			spec.autoThreshold < 0 ||
			spec.autoThreshold > 1
		) {
			throw new Error(`${id}: "autoThreshold" must be a number between 0 and 1`);
		}
		point.autoThreshold = spec.autoThreshold;
	}
	return point;
}

/** Read every `*.json` in `dir`, returning the points that parsed and the errors that did not. */
export function loadDecisionPointsFrom(dir: string): { points: UserDecisionPoint[]; errors: string[] } {
	const points: UserDecisionPoint[] = [];
	const errors: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		// A missing directory is the normal case: most projects declare no points.
		return { points, errors };
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const file = path.join(dir, entry.name);
		const id = entry.name.slice(0, -".json".length);
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
			points.push(parseDecisionPoint(id, raw, file));
		} catch (error) {
			errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { points, errors };
}

/**
 * Load every user point visible to a session.
 *
 * A project point overrides a user point of the same id: the narrower scope
 * wins, which is the same rule settings and skills follow.
 */
export function loadDecisionPoints(paths: DecisionPointPaths = {}): {
	points: UserDecisionPoint[];
	errors: string[];
} {
	const byId = new Map<string, UserDecisionPoint>();
	const errors: string[] = [];
	const dirs = [
		paths.agentDir ? path.join(paths.agentDir, "decisions") : undefined,
		paths.cwd ? path.join(paths.cwd, ".ngodeai", "decisions") : undefined,
	];
	for (const dir of dirs) {
		if (!dir) continue;
		const loaded = loadDecisionPointsFrom(dir);
		for (const point of loaded.points) byId.set(point.id, point);
		errors.push(...loaded.errors);
	}
	return { points: [...byId.values()], errors };
}

/** The threshold a user point may actually use, given its risk class. */
export function effectiveAutoThreshold(point: UserDecisionPoint, classCeiling: number): number {
	const requested = point.autoThreshold ?? classCeiling;
	// A file may tighten a gate, never loosen it: the effective threshold is the
	// higher of what it asked for and what its risk class allows.
	return Math.max(requested, classCeiling);
}

/** Log load failures once, at a level that does not interrupt a session. */
export function reportDecisionPointErrors(errors: readonly string[]): void {
	for (const error of errors) logger.warn("decision point rejected", { error });
}
