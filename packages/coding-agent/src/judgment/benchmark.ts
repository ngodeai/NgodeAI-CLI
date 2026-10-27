/**
 * Per-task accounting for the decision layer.
 *
 * A decision's cost is not its price. A cheap decision that routes a worker
 * down the wrong branch costs the whole branch; a "free" cache hit that made
 * the agent ask twice costs a turn. The only number that can compare two
 * configurations is **cost per finished task**, and computing it needs the
 * decisions and the task outcome in one place.
 *
 * This module is that place. It joins the ledger to the task tree:
 *
 * ```text
 * task
 *   ├─ decisions it caused        (cost, latency, cache hit rate)
 *   ├─ model calls it caused      (already in the session ledger)
 *   └─ outcome                    (completed / failed / abandoned, and how long)
 * ```
 *
 * ## What it deliberately does not do
 *
 * It does not estimate a saving. A baseline requires running the same task
 * without the layer, which is an experiment, not a calculation. Until that
 * experiment runs, the report states what happened and nothing about what
 * might have.
 */
import type { DecisionEvent, Judge, JudgmentState, NoulQuestion } from "@ngodeai/ai";
import type { DecisionLedger } from "./ledger";

/** How a task ended. */
export type TaskOutcome = "completed" | "failed" | "abandoned" | "running";

/** One task's decision cost. */
export interface TaskDecisionReport {
	/** Task id as the caller names it (a subagent id, a session id, a run label). */
	task: string;
	/** How the task ended. */
	outcome: TaskOutcome;
	/** Wall-clock milliseconds from task start to its last decision. */
	elapsedMs: number;
	/** Decisions the task caused. */
	decisions: number;
	/** Sum of their billed cost. */
	cost: number;
	/** Sum of their judge latency. */
	judgeMs: number;
	/** Decisions answered wholly from cache. */
	cached: number;
	/** Decisions that reached a human. */
	gated: number;
	/** Per-point breakdown, most expensive first. */
	byPoint: { point: string; count: number; cost: number; judgeMs: number }[];
	/** Cost per decision, for comparing points of different volume. */
	meanCost: number;
	/** Judge milliseconds per decision. */
	meanJudgeMs: number;
}

/** A task as the benchmark sees it. */
export interface TaskRecord {
	task: string;
	outcome: TaskOutcome;
	startedAt: number;
	finishedAt?: number;
	/** Decisions attributed to this task. */
	decisions: readonly DecisionEvent[];
}

/**
 * Build one task's report from the decisions attributed to it.
 *
 * Attribution is the caller's job: the ledger stores a session, not a task
 * tree, because a task boundary is a host concept. A subagent run passes the
 * decisions it observed; a whole session passes all of them.
 */
export function reportTask(record: TaskRecord): TaskDecisionReport {
	const byPoint = new Map<string, { point: string; count: number; cost: number; judgeMs: number }>();
	let cost = 0;
	let judgeMs = 0;
	let cached = 0;
	let gated = 0;
	let lastAt = record.startedAt;
	for (const decision of record.decisions) {
		const decisionCost = decision.cost ?? 0;
		const elapsed = decision.elapsedMs ?? 0;
		cost += decisionCost;
		judgeMs += elapsed;
		if (decision.cached) cached++;
		if (decision.action === "gated" || decision.action === "asked") gated++;
		if (decision.at > lastAt) lastAt = decision.at;
		const entry = byPoint.get(decision.point) ?? { point: decision.point, count: 0, cost: 0, judgeMs: 0 };
		entry.count++;
		entry.cost += decisionCost;
		entry.judgeMs += elapsed;
		byPoint.set(decision.point, entry);
	}
	const count = record.decisions.length;
	const end = record.finishedAt ?? lastAt;
	return {
		task: record.task,
		outcome: record.outcome,
		elapsedMs: Math.max(0, end - record.startedAt),
		decisions: count,
		cost,
		judgeMs,
		cached,
		gated,
		byPoint: [...byPoint.values()].sort((a, b) => b.cost - a.cost || b.count - a.count),
		meanCost: count === 0 ? 0 : cost / count,
		meanJudgeMs: count === 0 ? 0 : judgeMs / count,
	};
}

/**
 * Aggregate many task reports into one row per configuration.
 *
 * The comparison this enables is the only honest one: two configurations that
 * each finished the same tasks, compared on cost per finished task. A task that
 * did not finish is counted separately rather than folded in, because a cheap
 * failure is not a cheap success.
 */
export interface BenchmarkSummary {
	/** Configuration label, e.g. `baseline` or `jev-gate`. */
	label: string;
	tasks: number;
	completed: number;
	failed: number;
	abandoned: number;
	/** Total cost across every task, finished or not. */
	totalCost: number;
	/** Total judge latency. */
	totalJudgeMs: number;
	/** Total wall-clock time. */
	totalElapsedMs: number;
	/** Cost per *completed* task; `undefined` when none finished. */
	costPerCompleted: number | undefined;
	/** Judge milliseconds per completed task. */
	judgeMsPerCompleted: number | undefined;
	/** Wall-clock milliseconds per completed task. */
	elapsedMsPerCompleted: number | undefined;
	/** Total decisions. */
	decisions: number;
	/** Decisions that reached a human. */
	gated: number;
	/** Share of decisions answered wholly from cache, 0–1. */
	cacheHitRate: number;
}

/** Summarise one configuration's runs. */
export function summarise(label: string, reports: readonly TaskDecisionReport[]): BenchmarkSummary {
	let totalCost = 0;
	let totalJudgeMs = 0;
	let totalElapsedMs = 0;
	let decisions = 0;
	let gated = 0;
	let cached = 0;
	let completed = 0;
	let failed = 0;
	let abandoned = 0;
	for (const report of reports) {
		totalCost += report.cost;
		totalJudgeMs += report.judgeMs;
		totalElapsedMs += report.elapsedMs;
		decisions += report.decisions;
		gated += report.gated;
		cached += report.cached;
		if (report.outcome === "completed") completed++;
		else if (report.outcome === "failed") failed++;
		else if (report.outcome === "abandoned") abandoned++;
	}
	return {
		label,
		tasks: reports.length,
		completed,
		failed,
		abandoned,
		totalCost,
		totalJudgeMs,
		totalElapsedMs,
		costPerCompleted: completed === 0 ? undefined : totalCost / completed,
		judgeMsPerCompleted: completed === 0 ? undefined : totalJudgeMs / completed,
		elapsedMsPerCompleted: completed === 0 ? undefined : totalElapsedMs / completed,
		decisions,
		gated,
		cacheHitRate: decisions === 0 ? 0 : cached / decisions,
	};
}

/** Read the decisions a session recorded, for a whole-session benchmark. */
export function sessionDecisions(ledger: DecisionLedger, sessionId: string, limit = 10_000): DecisionEvent[] {
	return ledger.list({ session: sessionId, limit });
}

/** Empirical benchmark result comparing sequential vs batched decisions (Jev Step 5). */
export interface BatchBenchmarkResult {
	questions: number;
	sequentialMs: number;
	batchMs: number;
	speedup: number;
	sequentialInputTokens: number;
	batchInputTokens: number;
	tokenSavingsRatio: number;
}

/**
 * Run an empirical benchmark comparing 13 batched questions vs 13 sequential questions.
 *
 * Demonstrates Jev Step 5: batching N questions over 1 state payload sends the state once,
 * saving round-trips and repeated prompt tokens.
 */
export async function runBatchBenchmark(
	judge: Judge,
	options: { questionsCount?: number; signal?: AbortSignal } = {},
): Promise<BatchBenchmarkResult> {
	const count = options.questionsCount ?? 13;
	const state: JudgmentState = {
		module: "auth_gateway",
		action: "token_refresh",
		tier: "write",
		target: "https://api.ngodeai.net/v1/auth",
		payload_size: 4096,
		context: "Session token expired; re-authenticating with refresh lease",
	};

	const questionsMap: Record<string, NoulQuestion> = {};
	for (let i = 0; i < count; i++) {
		questionsMap[`q_${i}`] = {
			type: "noul",
			instructions: `Does check #${i} allow proceeding with token refresh?`,
		};
	}

	// 1. Batch execution: 1 request with all N questions
	const startBatch = performance.now();
	const batchResult = await judge.judge({ state, questions: questionsMap }, { signal: options.signal });
	const batchMs = Math.max(1, performance.now() - startBatch);
	const batchTokens = Math.max(1, batchResult.usage.input);

	// 2. Sequential execution: N separate requests with 1 question each
	let seqTokens = 0;
	const startSeq = performance.now();
	for (let i = 0; i < count; i++) {
		const singleResult = await judge.judge(
			{ state, questions: { [`q_${i}`]: questionsMap[`q_${i}`]! } },
			{ signal: options.signal },
		);
		seqTokens += singleResult.usage.input;
	}
	const sequentialMs = Math.max(1, performance.now() - startSeq);

	const speedup = Number((sequentialMs / batchMs).toFixed(1));
	const tokenSavingsRatio = Number((seqTokens / batchTokens).toFixed(1));

	return {
		questions: count,
		sequentialMs: Math.round(sequentialMs),
		batchMs: Math.round(batchMs),
		speedup,
		sequentialInputTokens: seqTokens,
		batchInputTokens: batchTokens,
		tokenSavingsRatio,
	};
}
