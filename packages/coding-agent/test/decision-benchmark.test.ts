/**
 * Cost per finished task, not cost per call.
 *
 * The property worth testing is that a cheap failure never reads as a cheap
 * success: cost-per-completed divides by completions, so an abandoned task
 * raises the number rather than lowering it.
 */
import { describe, expect, it } from "bun:test";
import { decisionFromResult, type JudgmentRequest, type JudgmentResult } from "@ngodeai/ai";
import { reportTask, summarise } from "../src/judgment";

const REQUEST: JudgmentRequest = {
	state: "s",
	questions: { q: { type: "noul", instructions: "?" } },
};

function result(cost: number): JudgmentResult {
	return {
		api: "typesafe",
		provider: "typesafe",
		model: "jev",
		answers: { q: { type: "noul", noul: 0.9 } },
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
	};
}

function decision(point: string, cost: number, at: number, elapsed = 40, cached = false) {
	return decisionFromResult(point, REQUEST, result(cost), { action: "auto" }, { at, elapsedMs: elapsed, cached });
}

describe("reportTask", () => {
	it("sums cost, latency, and cache hits across a task's decisions", () => {
		const report = reportTask({
			task: "t1",
			outcome: "completed",
			startedAt: 0,
			finishedAt: 1_000,
			decisions: [decision("ttsr", 0.00001, 100), decision("find", 0.00002, 400, 60, true)],
		});

		expect(report.decisions).toBe(2);
		expect(report.cost).toBeCloseTo(0.00003, 9);
		expect(report.judgeMs).toBe(100);
		expect(report.cached).toBe(1);
		expect(report.meanCost).toBeCloseTo(0.000015, 9);
	});

	it("breaks down by point, most expensive first", () => {
		const report = reportTask({
			task: "t1",
			outcome: "completed",
			startedAt: 0,
			decisions: [decision("ttsr", 0.000001, 100), decision("find", 0.0005, 200)],
		});
		expect(report.byPoint[0].point).toBe("find");
		expect(report.byPoint[1].point).toBe("ttsr");
	});

	it("measures elapsed to the last decision when no finish time is given", () => {
		const report = reportTask({
			task: "t1",
			outcome: "running",
			startedAt: 1_000,
			decisions: [decision("ttsr", 0, 1_500)],
		});
		expect(report.elapsedMs).toBe(500);
	});

	it("reports zeroes for a task that made no decisions", () => {
		const report = reportTask({ task: "t", outcome: "completed", startedAt: 0, finishedAt: 10, decisions: [] });
		expect(report.decisions).toBe(0);
		expect(report.meanCost).toBe(0);
		expect(report.meanJudgeMs).toBe(0);
		expect(report.byPoint).toHaveLength(0);
	});
});

describe("summarise", () => {
	it("divides cost by completed tasks, not by every task", () => {
		const completed = reportTask({
			task: "a",
			outcome: "completed",
			startedAt: 0,
			finishedAt: 100,
			decisions: [decision("ttsr", 0.001, 10)],
		});
		const failed = reportTask({
			task: "b",
			outcome: "failed",
			startedAt: 0,
			finishedAt: 100,
			decisions: [decision("ttsr", 0.001, 10)],
		});

		const summary = summarise("jev", [completed, failed]);
		expect(summary.tasks).toBe(2);
		expect(summary.completed).toBe(1);
		expect(summary.failed).toBe(1);
		// Both tasks' cost is counted, but divided by the one completion.
		expect(summary.totalCost).toBeCloseTo(0.002, 9);
		expect(summary.costPerCompleted).toBeCloseTo(0.002, 9);
	});

	it("leaves per-completed metrics undefined when nothing finished", () => {
		const failed = reportTask({
			task: "a",
			outcome: "failed",
			startedAt: 0,
			finishedAt: 10,
			decisions: [decision("ttsr", 0.001, 5)],
		});
		const summary = summarise("jev", [failed]);
		expect(summary.costPerCompleted).toBeUndefined();
		expect(summary.judgeMsPerCompleted).toBeUndefined();
	});

	it("reports the cache hit rate over decisions", () => {
		const report = reportTask({
			task: "a",
			outcome: "completed",
			startedAt: 0,
			decisions: [decision("ttsr", 0, 10, 5, true), decision("find", 0, 20, 5, false)],
		});
		expect(summarise("jev", [report]).cacheHitRate).toBe(0.5);
	});
});
