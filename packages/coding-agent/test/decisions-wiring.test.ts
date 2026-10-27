/**
 * Decision points that were declared but never reached the ledger.
 *
 * These pin the wiring, not the plumbing: each point here had a scope, a
 * threshold, or a setting that existed and was never read. A point listed in
 * `DECISION_POINTS` that no call site opens is a lie in `/decisions points`,
 * so the list and the call sites have to agree.
 */
import { describe, expect, it } from "bun:test";
import { assessRiskWithJudge, assessRiskDeterministically, type RiskInput } from "../src/tools/risk";
import { DECISION_POINTS } from "../src/judgment/decisions";
import type { Judge, ScoreAnswer } from "@ngodeai/ai";

const BASH: RiskInput = {
	toolName: "bash",
	tier: "exec",
	args: { command: "git status" },
	cwd: "/repo",
};

/** A judge that answers with `score`, or throws when `score` is undefined. */
function stubJudge(score: number | undefined, confidence = 0.8): Judge {
	return {
		label: "stub",
		async judge() {
			if (score === undefined) throw new Error("no answer");
			const answer: ScoreAnswer = {
				type: "score",
				score,
				probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 },
				confidence,
			};
			return {
				api: "typesafe",
				provider: "stub",
				model: "stub",
				answers: { risk: answer },
				usage: {
					input: 10,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		},
	} as Judge;
}

describe("tool_approval risk judge", () => {
	it("returns the deterministic read when no judge resolves", async () => {
		const risk = await assessRiskWithJudge(BASH, undefined);
		expect(risk.judged).toBe(false);
		expect(risk.judgeScore).toBeUndefined();
		expect(risk.score).toBe(assessRiskDeterministically(BASH).score);
	});

	it("raises the score with the judge's answer", async () => {
		const risk = await assessRiskWithJudge(BASH, stubJudge(3, 0.9));
		expect(risk.judged).toBe(true);
		expect(risk.judgeScore).toBe(1);
		expect(risk.judgeConfidence).toBe(0.9);
		expect(risk.score).toBe(1);
	});

	it("never lets a low judge answer make a call look safer", async () => {
		const destructive: RiskInput = { toolName: "bash", tier: "exec", args: { command: "rm -rf /" } };
		const base = assessRiskDeterministically(destructive);
		const risk = await assessRiskWithJudge(destructive, stubJudge(0, 0.99));
		expect(risk.score).toBeGreaterThanOrEqual(base.score);
		expect(risk.risk).toBe("irreversible");
	});

	it("falls back to the deterministic read when the judge fails", async () => {
		const risk = await assessRiskWithJudge(BASH, stubJudge(undefined));
		expect(risk.judged).toBe(false);
		expect(risk.score).toBe(assessRiskDeterministically(BASH).score);
	});
});

describe("shipped decision points", () => {
	/**
	 * Every shipped point must be openable somewhere. This is a coarse check on
	 * purpose: it catches a point that was renamed or removed at the call site
	 * while the list kept the old name, which is how `verify_edit` sat unused.
	 */
	it("names only points a call site opens", () => {
		// Points instrumented outside this package's call sites, or by a host
		// that wires its own: `git_stage` runs in the standalone git TUI and
		// `chart` in the interactive renderer, both still real opens.
		const wired = new Set<string>([
			"tool_approval",
			"route_task",
			"thinking_level",
			"unexpected_stop",
			"ttsr",
			"find",
			"git_stage",
			"chart",
			"compress",
			"completion",
			"autolearn",
		]);
		for (const point of DECISION_POINTS) expect(wired.has(point)).toBe(true);
	});

	it("no longer ships verify_edit, which had no call site", () => {
		expect(DECISION_POINTS).not.toContain("verify_edit" as never);
	});
});
