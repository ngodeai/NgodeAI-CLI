/**
 * Decision Queue: bounded-parallel judgment execution queue.
 *
 * Implements Jev Step 4 & 5: parallel decisions through an execution queue.
 * Dispatches waves of typed judgments concurrently with concurrency control,
 * aggregating all requests into a unified DecisionScope.
 */
import type { DecisionScope, Judge, JudgmentRequest, JudgmentResult, Questions } from "@ngodeai/ai";
import { mapWithConcurrencyLimitAllSettled } from "../task/parallel";

export interface DecisionQueueOptions {
	/** Concurrency cap (default 16, matching the Jev and find cascade standard). */
	concurrency?: number;
	/** Shared decision scope all queued judgments report to. */
	decision?: DecisionScope;
	signal?: AbortSignal;
}

/**
 * Execute a batch of judgment requests in parallel with concurrency control.
 * All results report their completions and usage to the given `decision` scope.
 */
export async function executeDecisionBatch<Q extends Questions>(
	requests: readonly JudgmentRequest<Q>[],
	judge: Judge,
	options: DecisionQueueOptions = {},
): Promise<JudgmentResult<Q>[]> {
	if (requests.length === 0) return [];
	const concurrency = options.concurrency ?? 16;
	const { results } = await mapWithConcurrencyLimitAllSettled(
		[...requests],
		concurrency,
		(req, _index, signal) =>
			judge.judge(req, {
				signal,
				decision: options.decision,
			}),
		options.signal,
	);
	return results.map((res, index) => {
		if (res?.status === "fulfilled") return res.value;
		const err = res?.reason instanceof Error ? res.reason : new Error(String(res?.reason ?? "judgment failed"));
		throw new Error(`decision queue item #${index} failed: ${err.message}`);
	});
}
