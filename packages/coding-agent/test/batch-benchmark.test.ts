/**
 * Empirical batch benchmark test (Jev Step 5).
 *
 * Verifies that runBatchBenchmark computes correct speedup and token efficiency
 * metrics when comparing sequential vs batched decisions.
 */
import { describe, expect, it } from "bun:test";
import { runBatchBenchmark } from "../src/judgment/benchmark";
import type { Judge, JudgmentRequest, JudgmentResult, NoulAnswer, Questions } from "@ngodeai/ai";

function makeBenchmarkStubJudge(): Judge {
	return {
		label: "bench-stub",
		async judge<Q extends Questions>(request: JudgmentRequest<Q>) {
			const count = Object.keys(request.questions).length;
			const answers = Object.fromEntries(
				Object.keys(request.questions).map(key => [key, { type: "noul", noul: 0.9 } as NoulAnswer]),
			) as JudgmentResult<Q>["answers"];
			// State size = 100 tokens. Each question in request adds 5 tokens.
			// Batched: 100 + count * 5. Sequential: count * (100 + 5) = count * 105.
			const inputTokens = 100 + count * 5;
			return {
				api: "typesafe",
				provider: "test",
				model: "mercury-decide",
				answers,
				usage: {
					input: inputTokens,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: inputTokens,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		},
	};
}

describe("runBatchBenchmark", () => {
	it("demonstrates token efficiency and speedup ratio for 13 questions", async () => {
		const judge = makeBenchmarkStubJudge();
		const result = await runBatchBenchmark(judge, { questionsCount: 13 });

		expect(result.questions).toBe(13);
		// Batched tokens = 100 + 13 * 5 = 165
		// Sequential tokens = 13 * (100 + 5) = 1365
		// Savings ratio = 1365 / 165 ≈ 8.3x
		expect(result.batchInputTokens).toBe(165);
		expect(result.sequentialInputTokens).toBe(1365);
		expect(result.tokenSavingsRatio).toBeGreaterThan(5);
		expect(result.speedup).toBeGreaterThanOrEqual(1);
	});
});
