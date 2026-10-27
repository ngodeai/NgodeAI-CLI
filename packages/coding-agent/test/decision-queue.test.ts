/**
 * Decision Queue: bounded-parallel judgment execution queue.
 *
 * Pins Jev Step 4 & 5: parallel decision execution with a concurrency queue
 * aggregating into a unified decision scope.
 */
import { describe, expect, it } from "bun:test";
import { executeDecisionBatch } from "../src/judgment/queue";
import type { DecisionScope, Judge, JudgmentRequest, JudgmentResult, NoulAnswer, Questions } from "@ngodeai/ai";
import { DecisionLayer, DecisionLedger } from "../src/judgment";
import * as path from "node:path";
import { TempDir } from "@ngodeai/utils";

function makeStubJudge(): Judge {
	let inFlight = 0;
	let maxInFlight = 0;
	return {
		label: "test-stub",
		async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: { decision?: DecisionScope }) {
			inFlight++;
			if (inFlight > maxInFlight) maxInFlight = inFlight;
			// Yield to microtask queue to allow other concurrent workers to run
			await Promise.resolve();
			inFlight--;
			const answers = Object.fromEntries(
				Object.keys(request.questions).map(key => [key, { type: "noul", noul: 0.95 } as NoulAnswer]),
			) as JudgmentResult<Q>["answers"];
			const result: JudgmentResult<Q> = {
				api: "typesafe",
				provider: "test",
				model: "mercury-decide",
				answers,
				usage: {
					input: 10,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			options?.decision?.complete(request, result, { startedAt: Date.now() - 5, finishedAt: Date.now() });
			return result;
		},
	};
}

describe("DecisionQueue", () => {
	it("returns empty results for empty requests", async () => {
		const judge = makeStubJudge();
		const results = await executeDecisionBatch([], judge);
		expect(results).toHaveLength(0);
	});

	it("executes batch of requests with concurrency control", async () => {
		const judge = makeStubJudge();
		const requests: JudgmentRequest[] = Array.from({ length: 8 }, (_, i) => ({
			state: { id: i },
			questions: { valid: { type: "noul" as const, instructions: "Is it valid?" } },
		}));
		const results = await executeDecisionBatch(requests, judge, { concurrency: 4 });
		expect(results).toHaveLength(8);
		for (const res of results) {
			const validAnswer = res.answers.valid as NoulAnswer;
			expect(validAnswer.noul).toBe(0.95);
		}
	});

	it("integrates with DecisionScope for unified accounting", async () => {
		using tempDir = TempDir.createSync("@ngodeai-dec-queue-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		const layer = DecisionLayer.open({ ledger, sessionId: "queue-test" });
		const scope = layer.open("find", { risk: "read" });
		const judge = makeStubJudge();

		const requests: JudgmentRequest[] = Array.from({ length: 5 }, (_, i) => ({
			state: { item: i },
			questions: { match: { type: "noul" as const, instructions: "Matches?" } },
		}));

		const results = await executeDecisionBatch(requests, judge, { concurrency: 4, decision: scope });
		expect(results).toHaveLength(5);

		scope.settle({
			action: "auto",
			tier: "line",
			reason: "5 queued decisions evaluated",
		});

		const rows = ledger.list({ session: "queue-test" });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.point).toBe("find");
		expect(rows[0]!.action).toBe("auto");
		ledger.close();
	});
});
