/**
 * Risk assessment for a tool call that is about to ask for approval.
 *
 * The dialog this feeds answers one question: *should a human look at this?*
 * That question has two halves, and they want different machinery.
 *
 * **What the call is** is deterministic and already known: the tool's
 * capability tier, whether the target sits inside the session root, whether a
 * grant already covers it, whether the command is a known-destructive shape.
 * Code answers this half, cheaply and identically every time.
 *
 * **Whether the call is dangerous in context** is a judgment. A `rm -rf` on a
 * build directory is routine; the same command on a home directory is not, and
 * the difference is not in the token stream — it is in what the paths mean.
 * That half goes to the judge as a `score` question, and the answer is
 * calibrated enough to threshold.
 *
 * The two are combined conservatively: a deterministic signal can raise the
 * risk on its own, and the judge can raise it further, but neither can lower it
 * below what the other found. A missing judge therefore never makes a call look
 * safer than code already knows it is.
 *
 * ## What this is not
 *
 * This module never decides to run something. It produces a
 * {@link RiskAssessment}; the approval path decides what to do with it. An
 * irreversible call is never auto-approved, whatever number comes back — that
 * rule lives in `DecisionLayer.gate` and is structural, not a threshold.
 */
import type { DecisionEvent, DecisionScope, JsonValue, Judge } from "@ngodeai/ai";
import type { ToolTier } from "@ngodeai/agent-core";

/** How dangerous acting on a call is, in the vocabulary the gate matrix uses. */
export type RiskClass = "read" | "write" | "irreversible";

/** One deterministic observation about a call, and how much it raises the risk. */
export interface RiskSignal {
	/** Stable id, so a UI can group or filter by kind. */
	id: string;
	/** What was observed, in the operator's words. */
	detail: string;
	/** 0–1; the assessment's deterministic floor is the highest signal. */
	weight: number;
}

/** The assessment a caller acts on. */
export interface RiskAssessment {
	/** Highest risk class any signal or the tier justifies. */
	risk: RiskClass;
	/** 0–1, the deterministic floor raised by the judge's score when it ran. */
	score: number;
	/** Every deterministic observation, strongest first. */
	signals: readonly RiskSignal[];
	/** Whether acting can be undone; false makes `risk` `irreversible`. */
	reversible: boolean;
	/** One line naming what drove the assessment, for the dialog's `why` row. */
	reason: string;
	/** The judge's calibrated score, when one answered. */
	judgeScore?: number;
	/** Confidence the judge reported for its score. */
	judgeConfidence?: number;
	/** Whether the judge was consulted at all. */
	judged: boolean;
}

/** A tool call as the assessor sees it. */
export interface RiskInput {
	toolName: string;
	/** Capability tier the approval resolver already computed. */
	tier: ToolTier;
	/** The call's arguments, for path and command inspection. */
	args: unknown;
	/** Session root, so a path outside it can be flagged. */
	cwd?: string;
	/** Cache targets the tool declares, when it declares any. */
	targets?: readonly string[];
	/** Whether an existing grant already covers every target. */
	granted?: boolean;
	/** Why the approval resolver decided to prompt, when it said. */
	reason?: string;
}

/** Command shapes that destroy data outright, matched case-insensitively on the command text. */
const DESTRUCTIVE_PATTERNS: readonly {
	readonly id: string;
	readonly pattern: RegExp;
	readonly detail: string;
	readonly weight: number;
}[] = [
	{
		id: "rm-root",
		pattern: /\brm\s+(-[a-z]+\s+)*(\/|~|\$HOME)(\/|\s|$)/i,
		detail: "deletes a home or root path",
		weight: 0.97,
	},
	{
		id: "rm-recursive",
		pattern: /\brm\s+(-[a-z]+\s+)*-[a-z]*(r[a-z]*f|f[a-z]*r)/i,
		detail: "recursive forced delete",
		weight: 0.94,
	},
	{ id: "git-reset-hard", pattern: /\bgit\s+reset\s+--hard\b/i, detail: "discards uncommitted work", weight: 0.85 },
	{ id: "git-clean", pattern: /\bgit\s+clean\s+-[a-z]*[dfx]/i, detail: "deletes untracked files", weight: 0.85 },
	{
		id: "force-push",
		pattern: /\bgit\s+push\b[^\n]*--force|\bgit\s+push\b[^\n]*\s-f(\s|$)/i,
		detail: "rewrites remote history",
		weight: 0.9,
	},
	{
		id: "drop-table",
		pattern: /\bdrop\s+(table|database|schema)\b/i,
		detail: "drops a database object",
		weight: 0.92,
	},
	{ id: "truncate", pattern: /\btruncate\s+table\b/i, detail: "empties a table", weight: 0.9 },
	{ id: "dd-device", pattern: /\bdd\b[^\n]*\bof=\/dev\//i, detail: "writes to a block device", weight: 0.99 },
	{ id: "mkfs", pattern: /\bmkfs(\.\w+)?\b/i, detail: "formats a filesystem", weight: 0.99 },
	{ id: "chmod-777", pattern: /\bchmod\s+(-[a-z]+\s+)*777\b/i, detail: "grants world write access", weight: 0.6 },
	{
		id: "curl-pipe-sh",
		pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i,
		detail: "pipes a download into a shell",
		weight: 0.8,
	},
	{ id: "sudo", pattern: /(^|[\s;&|])sudo\s/i, detail: "runs with elevated privileges", weight: 0.75 },
	{ id: "shutdown", pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, detail: "stops the machine", weight: 0.9 },
	{
		id: "kill-all",
		pattern: /\bkillall\b|\bkill\s+-9\s+-1\b|\bpkill\s+-9\b/i,
		detail: "kills processes broadly",
		weight: 0.8,
	},
];

/** Tool names whose whole purpose is irreversible: no confidence makes them safe to auto-run. */
const IRREVERSIBLE_TOOLS: ReadonlySet<string> = new Set(["delete", "remove", "rm", "unlink", "rmdir"]);

/** Extract the command text from a call's arguments, whatever shape the tool uses. */
function commandText(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["command", "cmd", "script", "code"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

/** Every path-like argument, so a target outside the session root can be spotted. */
function pathArguments(args: unknown): string[] {
	if (typeof args !== "object" || args === null) return [];
	const record = args as Record<string, unknown>;
	const found: string[] = [];
	for (const key of ["path", "file", "file_path", "filePath", "target", "destination", "dest", "source", "src"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) found.push(value);
	}
	const paths = record.paths;
	if (Array.isArray(paths)) {
		for (const value of paths) if (typeof value === "string" && value.length > 0) found.push(value);
	}
	return found;
}

/** Whether `candidate` sits outside `root`, resolving `..` and relative paths first. */
function isOutside(candidate: string, root: string): boolean {
	if (!candidate) return false;
	// Absolute paths are the ones that can leave the tree; a relative path is
	// resolved against the root and cannot escape it without `..`, which the
	// normalizer below folds back in.
	let resolved: string;
	try {
		resolved = candidate.startsWith("/") || /^[a-zA-Z]:/.test(candidate) ? candidate : `${root}/${candidate}`;
	} catch {
		return false;
	}
	const normalize = (value: string): string[] => {
		const parts: string[] = [];
		for (const segment of value.replace(/\\/g, "/").split("/")) {
			if (segment === "" || segment === ".") continue;
			if (segment === "..") {
				parts.pop();
				continue;
			}
			parts.push(segment.toLowerCase());
		}
		return parts;
	};
	const target = normalize(resolved);
	const base = normalize(root);
	if (target.length < base.length) return true;
	return base.some((segment, index) => target[index] !== segment);
}

/**
 * Deterministic assessment of `input`.
 *
 * Pure and synchronous: no judge, no I/O. The score is the strongest signal,
 * floored by the capability tier, so a call never reads as safer than the tier
 * the approval resolver already assigned it.
 */
export function assessRiskDeterministically(input: RiskInput): RiskAssessment {
	const signals: RiskSignal[] = [];
	let reversible = true;
	/** Signals that remove data outright; they make the call irreversible regardless of tier. */
	const irreversibleSignals = new Set([
		"rm-root",
		"rm-recursive",
		"dd-device",
		"mkfs",
		"drop-table",
		"truncate",
		"irreversible-tool",
	]);

	if (IRREVERSIBLE_TOOLS.has(input.toolName)) {
		signals.push({ id: "irreversible-tool", detail: `${input.toolName} cannot be undone`, weight: 0.95 });
		reversible = false;
	}

	const command = commandText(input.args);
	if (command) {
		for (const { id, pattern, detail, weight } of DESTRUCTIVE_PATTERNS) {
			if (!pattern.test(command)) continue;
			signals.push({ id, detail, weight });
			if (irreversibleSignals.has(id)) reversible = false;
		}
	}

	if (input.cwd) {
		for (const candidate of pathArguments(input.args)) {
			if (!isOutside(candidate, input.cwd)) continue;
			signals.push({ id: "outside-root", detail: `${candidate} is outside the session root`, weight: 0.72 });
			break;
		}
	}

	if (input.tier === "exec" && command === undefined) {
		// An exec-tier tool with no inspectable command is a shell we cannot read.
		signals.push({ id: "opaque-exec", detail: "runs code that cannot be inspected", weight: 0.7 });
	}

	// A granted target is the user having already said yes to this exact thing.
	if (input.granted && signals.length === 0) {
		signals.push({ id: "granted", detail: "an existing grant covers this target", weight: 0.15 });
	}

	signals.sort((a, b) => b.weight - a.weight);

	const tierFloor = input.tier === "exec" ? 0.7 : input.tier === "write" ? 0.45 : 0.1;
	const score = Math.max(tierFloor, signals[0]?.weight ?? 0);
	const risk: RiskClass = !reversible
		? "irreversible"
		: score >= 0.9
			? "irreversible"
			: input.tier === "read"
				? "read"
				: "write";

	const reason =
		signals.length > 0
			? signals
					.slice(0, 2)
					.map(signal => signal.detail)
					.join(", ")
			: `${input.tier}-tier call with nothing unusual`;

	return { risk, score, signals, reversible, reason, judged: false };
}

/**
 * The question asked of the judge when a call needs a contextual read.
 *
 * One `score` rather than a `noul` per hazard: the answer is an ordered
 * severity, and a score's levels already carry the ordering the operator will
 * read in the dialog. The state carries the deterministic findings, so the
 * judge is sharpening a conclusion rather than forming one from scratch.
 */
export const RISK_QUESTION = {
	instructions:
		"How much would a careful engineer want to review this tool call before it runs? Consider what the command or write actually does, where it lands, and what cannot be undone. Judge the action itself, not whether the tool is trustworthy.",
	criteria: [
		"Routine: reads, or a write confined to the session's own files with an obvious purpose",
		"Worth a glance: broad but recoverable, e.g. touching many files or a shared resource",
		"Needs review: hard to undo, reaches outside the session, or its effect is not clear from the arguments",
		"Must not run unattended: destroys data, rewrites history, or escalates privilege",
	] as [string, string, string, string],
} as const;

/** The state sent with {@link RISK_QUESTION}. */
export function riskState(input: RiskInput, deterministic: RiskAssessment): Record<string, JsonValue> {
	return {
		tool: input.toolName,
		tier: input.tier,
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
		...(commandText(input.args) === undefined ? {} : { command: commandText(input.args)! }),
		...(input.targets?.length ? { targets: [...input.targets] } : {}),
		deterministic_signals: deterministic.signals.map(signal => ({ id: signal.id, detail: signal.detail })),
	};
}

/**
 * Raise `deterministic` with the judge's score.
 *
 * The judge can only make the call look riskier, never safer: a judge that
 * returns "routine" for a command code flagged as `rm -rf /` is a judge to
 * distrust, not one to defer to. The combined score is therefore the larger of
 * the two, and the class never drops below what the signals justified.
 */
export function mergeJudgeRisk(
	deterministic: RiskAssessment,
	answer: { score: number; confidence?: number },
): RiskAssessment {
	const normalized = Math.max(0, Math.min(1, answer.score / 3));
	const score = Math.max(deterministic.score, normalized);
	const risk: RiskClass =
		!deterministic.reversible || deterministic.risk === "irreversible"
			? "irreversible"
			: score >= 0.9
				? "irreversible"
				: deterministic.risk;
	return {
		...deterministic,
		score,
		risk,
		judgeScore: normalized,
		...(answer.confidence === undefined ? {} : { judgeConfidence: answer.confidence }),
		judged: true,
		reason:
			normalized > deterministic.score
				? `model review rated this ${normalized.toFixed(2)}; ${deterministic.reason}`
				: deterministic.reason,
	};
}

/**
 * The deterministic read, raised by a contextual judge when one answers.
 *
 * Advisory in both directions: a failed or missing judge leaves the
 * deterministic assessment untouched, and a judge that answers lower than the
 * signals still cannot make the call look safer ({@link mergeJudgeRisk}). The
 * approval decision stays fail-closed on the user's answer either way.
 */
export async function assessRiskWithJudge(
	input: RiskInput,
	judge: Judge | undefined,
	options: { signal?: AbortSignal; decision?: DecisionScope } = {},
): Promise<RiskAssessment> {
	const deterministic = assessRiskDeterministically(input);
	if (!judge) return deterministic;
	try {
		const { answers } = await judge.judge(
			{
				state: riskState(input, deterministic),
				questions: { risk: { type: "score", ...RISK_QUESTION } },
			},
			{
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.decision === undefined ? {} : { decision: options.decision }),
			},
		);
		const answer = answers.risk;
		if (typeof answer?.score !== "number" || !Number.isFinite(answer.score)) return deterministic;
		return mergeJudgeRisk(deterministic, {
			score: answer.score,
			...(typeof answer.confidence === "number" ? { confidence: answer.confidence } : {}),
		});
	} catch {
		// A judge that cannot answer must not delay or soften an approval prompt.
		return deterministic;
	}
}

/**
 * A one-line `why` for the approval dialog.
 *
 * Built from the signals rather than from generated prose: the dialog must not
 * present a model's sentence as if it were an observation. When the judge
 * raised the score, that is stated as a rating, with its number.
 */
export function riskReason(assessment: RiskAssessment): string {
	if (assessment.signals.length === 0) return assessment.reason;
	const top = assessment.signals.slice(0, 2).map(signal => signal.detail);
	const judged =
		assessment.judgeScore !== undefined && assessment.judgeScore > 0
			? `; model review ${assessment.judgeScore.toFixed(2)}`
			: "";
	return `${top.join("; ")}${judged}`;
}

/**
 * Build the decision event for one approval prompt.
 *
 * The event is constructed rather than derived from a judgment because this
 * gate is not a judgment: the risk assessment is the observation, and the
 * user's answer is the outcome. Recording both is what makes `/decisions`
 * answer "what did it ask me about, and what did I say?" rather than only
 * "how risky did it think this was".
 *
 * A prompt answered `deny` is `blocked`; an approval is `gated` (a human was
 * involved) even when the dialog was dismissed by a grant, because the grant
 * was a human's earlier answer to the same question.
 */
export function approvalDecision(
	toolName: string,
	tier: ToolTier,
	risk: RiskAssessment,
	approved: boolean,
	answer: "once" | "session" | "deny" | { grant: string; always?: boolean } | undefined,
): DecisionEvent {
	const how =
		answer === "once"
			? "approved once"
			: answer === "session"
				? "approved for the session"
				: typeof answer === "object"
					? `granted ${answer.grant}${answer.always ? " (always)" : ""}`
					: "denied";
	return {
		at: Date.now(),
		point: "tool_approval",
		model: "deterministic",
		api: "risk",
		provider: "local",
		questions: [
			{
				id: "risk",
				type: "score",
				instructions: `How much review does this ${toolName} call need?`,
				criteria: RISK_QUESTION.criteria,
			},
		],
		answers: [
			{
				question: "risk",
				type: "score",
				value: Math.round(risk.score * 3),
				...(risk.judgeScore === undefined
					? {}
					: {
							probabilities: {
								"0": 1 - risk.judgeScore,
								"1": 0,
								"2": 0,
								"3": risk.judgeScore,
							},
						}),
				...(risk.judgeConfidence === undefined ? {} : { confidence: risk.judgeConfidence }),
			},
		],
		action: approved ? "gated" : "blocked",
		tier: "line",
		risk: risk.risk,
		confidence: risk.judgeConfidence ?? risk.score,
		decisionKeys: ["risk"],
		reason: `${how} · ${riskReason(risk)}`,
	};
}
