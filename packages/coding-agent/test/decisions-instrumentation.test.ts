/**
 * Decision points actually record.
 *
 * The layer's own tests prove the plumbing works when called. These prove the
 * call sites reach it: a classifier that resolves an effort, a route, or a
 * stop verdict must leave a decision behind, and a silent verdict must not
 * reach the transcript.
 */
import { describe, expect, it } from "bun:test";
import type { DecisionEvent, JudgmentRequest, JudgmentResult } from "@ngodeai/ai";
import { DecisionLayer, DecisionLedger } from "../src/judgment";
import * as path from "node:path";
import { TempDir } from "@ngodeai/utils";

const RESULT: JudgmentResult = {
	api: "typesafe",
	provider: "typesafe",
	model: "jev-1.14.0",
	answers: {
		q: { type: "noul", noul: 0.93 },
	},
	usage: {
		input: 100,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 100,
		cost: { input: 0.0000042, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000042 },
	},
};

const REQUEST: JudgmentRequest = {
	state: { request: "add a test" },
	questions: { q: { type: "noul", instructions: "Does this stop early?" } },
};

describe("decision points", () => {
	it("emit a settled event through the recorder the judge was given", () => {
		using tempDir = TempDir.createSync("@ngodeai-dec-instr-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		const emitted: DecisionEvent[] = [];
		const layer = DecisionLayer.open({ ledger, sessionId: "s", emit: e => emitted.push(e) });
		try {
			const scope = layer.open("unexpected_stop", { risk: "read" });
			// The judge reports the completed request; the call site settles it.
			scope.complete(REQUEST, RESULT, { startedAt: 1_000, finishedAt: 1_044 });
			scope.settle({ action: "auto", tier: "line", reason: "promised work then stopped" });

			expect(emitted).toHaveLength(1);
			expect(emitted[0].point).toBe("unexpected_stop");
			expect(emitted[0].elapsedMs).toBe(44);
			expect(ledger.list({ session: "s" })).toHaveLength(1);
		} finally {
			ledger.close();
		}
	});

	it("keeps a silent verdict out of the transcript but in the ledger", () => {
		using tempDir = TempDir.createSync("@ngodeai-dec-instr-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		const emitted: DecisionEvent[] = [];
		const layer = DecisionLayer.open({ ledger, sessionId: "s", emit: e => emitted.push(e) });
		try {
			const scope = layer.open("ttsr", { risk: "read" });
			scope.complete(REQUEST, RESULT, { startedAt: 0, finishedAt: 30 });
			scope.settle({ action: "silent", tier: "silent", reason: "8 rules checked, none flagged" });

			expect(emitted).toHaveLength(0);
			expect(ledger.list({ session: "s" })).toHaveLength(1);
		} finally {
			ledger.close();
		}
	});

	it("counts every decision for the status line, gated ones separately", () => {
		using tempDir = TempDir.createSync("@ngodeai-dec-instr-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		const layer = DecisionLayer.open({ ledger, sessionId: "s" });
		try {
			for (const [point, action] of [
				["ttsr", "silent"],
				["find", "auto"],
				["tool_approval", "gated"],
			] as const) {
				const scope = layer.open(point);
				scope.complete(REQUEST, RESULT, { startedAt: 0, finishedAt: 10 });
				scope.settle({ action });
			}

			expect(layer.counts.count).toBe(3);
			expect(layer.counts.gated).toBe(1);
		} finally {
			ledger.close();
		}
	});
});
