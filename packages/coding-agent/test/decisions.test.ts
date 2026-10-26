/**
 * The decision layer's contract, independent of any model.
 *
 * These tests pin the parts that must hold no matter which judge answers:
 * a scope records what the caller settled, a silent layer records nothing, the
 * confidence matrix never auto-approves an irreversible action, and the ledger
 * round-trips an event without losing the probabilities a UI draws.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@ngodeai/utils";
import {
	type DecisionEvent,
	DecisionRecorder,
	decisionConfidence,
	decisionFromResult,
	decisionStateDigest,
} from "@ngodeai/ai";
import type { JudgmentRequest, JudgmentResult } from "@ngodeai/ai";
import { DecisionLayer, DecisionLedger, resolveDecisionThresholds } from "../src/judgment";

const REQUEST: JudgmentRequest = {
	state: { command: "rm -rf build/", cwd: "/repo" },
	questions: {
		allowed: {
			type: "choice",
			instructions: "May this command run?",
			criteria: { allow: "safe", ask: "needs a human", deny: "destructive" },
		},
	},
};

const RESULT: JudgmentResult = {
	api: "typesafe",
	provider: "typesafe",
	model: "jev-1.14.0",
	answers: {
		allowed: {
			type: "choice",
			choice: "ask",
			probabilities: { allow: 0.24, ask: 0.71, deny: 0.05 },
			confidence: 0.565,
		},
	},
	usage: {
		input: 412,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 412,
		cost: { input: 0.0000173, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000173 },
	},
};

describe("DecisionRecorder", () => {
	it("settles a scope into one event carrying the answer's distribution", () => {
		const seen: DecisionEvent[] = [];
		const recorder = new DecisionRecorder(event => seen.push(event), "session-1");
		const scope = recorder.open("tool_approval", { risk: "write" });

		scope.complete(REQUEST, RESULT, { startedAt: 1_000, finishedAt: 1_038 });
		const event = scope.settle({ action: "gated", reason: "confidence under the write threshold" });

		expect(seen).toHaveLength(1);
		expect(event?.point).toBe("tool_approval");
		expect(event?.risk).toBe("write");
		expect(event?.action).toBe("gated");
		expect(event?.tier).toBe("line");
		expect(event?.sessionId).toBe("session-1");
		expect(event?.elapsedMs).toBe(38);
		expect(event?.answers[0].probabilities).toEqual({ allow: 0.24, ask: 0.71, deny: 0.05 });
		// A Choice carries its own confidence; the gate compares that number.
		expect(event?.confidence).toBe(0.565);
	});

	it("settles once: a second settle is a no-op", () => {
		const seen: DecisionEvent[] = [];
		const scope = new DecisionRecorder(event => seen.push(event)).open("ttsr");
		scope.complete(REQUEST, RESULT, { startedAt: 0, finishedAt: 1 });

		expect(scope.settle({ action: "auto" })).toBeDefined();
		expect(scope.settle({ action: "blocked" })).toBeUndefined();
		expect(seen).toHaveLength(1);
		expect(seen[0].action).toBe("auto");
	});

	it("records nothing when the judgment never completed", () => {
		const seen: DecisionEvent[] = [];
		const scope = new DecisionRecorder(event => seen.push(event)).open("tool_approval");
		scope.fail(new Error("no judge available"));

		expect(scope.settle({ action: "gated" })).toBeUndefined();
		expect(seen).toHaveLength(0);
	});
});

describe("confidence", () => {
	it("takes the lowest confidence among the answers the action depended on", () => {
		const event = decisionFromResult(
			"tool_approval",
			{
				state: "s",
				questions: {
					safe: { type: "noul", instructions: "safe?" },
					kind: { type: "choice", instructions: "which?", criteria: { a: null, b: null } },
				},
			},
			{
				api: "typesafe",
				provider: "typesafe",
				model: "jev",
				answers: {
					safe: { type: "noul", noul: 0.98 },
					kind: { type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.2 },
				},
				usage: RESULT.usage,
			},
			{ action: "auto", decisionKeys: ["safe", "kind"] },
		);

		// The noul has no confidence of its own; |2p-1| puts it on the same scale.
		expect(event.confidence).toBeCloseTo(0.2, 6);
	});

	it("is undefined when the keys name no answer", () => {
		expect(decisionConfidence([], ["missing"])).toBeUndefined();
	});
});

describe("DecisionLayer gate", () => {
	it("never auto-approves an irreversible action, whatever the confidence", () => {
		const layer = DecisionLayer.open({ ledger: undefined, emit: undefined });
		const gate = layer.gate("tool_approval", 1, "irreversible");

		expect(gate.verdict).toBe("ask");
		expect(gate.autoThreshold).toBe(Number.POSITIVE_INFINITY);
	});

	it("keeps irreversible non-auto even when the configured threshold says otherwise", () => {
		const thresholds = resolveDecisionThresholds({ irreversible: { auto: 0.1, escalate: 0.05 } });
		expect(thresholds.irreversible.auto).toBe(Number.POSITIVE_INFINITY);
	});

	it("acts on a read above its threshold, asks below it, and refuses under the floor", () => {
		const layer = DecisionLayer.open({ ledger: undefined, emit: undefined });

		expect(layer.gate("find", 0.9, "read").verdict).toBe("auto");
		expect(layer.gate("find", 0.6, "read").verdict).toBe("ask");
		expect(layer.gate("find", 0.1, "read").verdict).toBe("block");
	});

	it("asks when there is no calibrated answer to compare", () => {
		const layer = DecisionLayer.open({ ledger: undefined, emit: undefined });
		expect(layer.gate("tool_approval", undefined, "write").verdict).toBe("ask");
	});

	it("records nothing and emits nothing when silent", () => {
		const seen: DecisionEvent[] = [];
		const layer = DecisionLayer.silent();
		const scope = layer.open("tool_approval");
		scope.complete(REQUEST, RESULT, { startedAt: 0, finishedAt: 1 });

		expect(scope.settle({ action: "gated" })).toBeUndefined();
		expect(seen).toHaveLength(0);
		expect(layer.enabled).toBe(false);
	});
});

describe("DecisionLedger", () => {
	it("round-trips a decision with its questions, answers, and probabilities", () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			const event = decisionFromResult(
				"tool_approval",
				REQUEST,
				RESULT,
				{
					action: "gated",
					risk: "write",
					reason: "confidence under the write threshold",
					keepState: true,
				},
				{ sessionId: "s1", elapsedMs: 38 },
			);
			const id = ledger.append(event);
			expect(id).toBeDefined();

			const stored = ledger.get(id!);
			expect(stored?.point).toBe("tool_approval");
			expect(stored?.action).toBe("gated");
			expect(stored?.reason).toBe("confidence under the write threshold");
			expect(stored?.questions).toHaveLength(1);
			expect(stored?.questions[0].instructions).toBe("May this command run?");
			expect(stored?.answers[0].value).toBe("ask");
			expect(stored?.answers[0].probabilities).toEqual({ allow: 0.24, ask: 0.71, deny: 0.05 });
			// `keepState` is what makes the state readable from the detail view.
			expect(stored?.state).toEqual(REQUEST.state);
		} finally {
			ledger.close();
		}
	});

	it("keeps the state digest even when the state itself is not kept", () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			const event = decisionFromResult("find", REQUEST, RESULT, { action: "auto" });
			const stored = ledger.get(ledger.append(event)!)!;

			expect(stored.state).toBeUndefined();
			expect(stored.stateDigest).toBe(decisionStateDigest(REQUEST.state));
		} finally {
			ledger.close();
		}
	});

	it("filters by session, point, action, and conflict", () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			ledger.append(decisionFromResult("find", REQUEST, RESULT, { action: "auto" }, { sessionId: "a" }));
			ledger.append(decisionFromResult("ttsr", REQUEST, RESULT, { action: "blocked" }, { sessionId: "a" }));
			ledger.append(
				decisionFromResult(
					"verify_edit",
					REQUEST,
					RESULT,
					{
						action: "auto",
						conflict: "typecheck failed after a pass",
					},
					{ sessionId: "b" },
				),
			);

			expect(ledger.list({ session: "a" })).toHaveLength(2);
			expect(ledger.list({ session: "a", points: ["ttsr"] })).toHaveLength(1);
			expect(ledger.list({ actions: ["auto"] })).toHaveLength(2);
			expect(ledger.list({ conflictsOnly: true })).toHaveLength(1);
		} finally {
			ledger.close();
		}
	});

	it("totals a session's cost, gated count, and cache hits", () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			ledger.append(decisionFromResult("tool_approval", REQUEST, RESULT, { action: "gated" }, { sessionId: "s" }));
			ledger.append(
				decisionFromResult("find", REQUEST, RESULT, { action: "auto" }, { sessionId: "s", cached: true }),
			);

			const totals = ledger.totals({ session: "s" });
			expect(totals.count).toBe(2);
			expect(totals.gated).toBe(1);
			expect(totals.cached).toBe(1);
			expect(totals.cost).toBeCloseTo(RESULT.usage.cost.total * 2, 9);
		} finally {
			ledger.close();
		}
	});

	it("summarises per point, most active first", () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			for (let i = 0; i < 3; i++) {
				ledger.append(decisionFromResult("ttsr", REQUEST, RESULT, { action: "silent" }, { sessionId: "s" }));
			}
			ledger.append(decisionFromResult("tool_approval", REQUEST, RESULT, { action: "gated" }, { sessionId: "s" }));

			const points = ledger.points({ session: "s" });
			expect(points[0].point).toBe("ttsr");
			expect(points[0].count).toBe(3);
			expect(points[1].point).toBe("tool_approval");
			expect(points[1].gated).toBe(1);
		} finally {
			ledger.close();
		}
	});

	it("survives a row that fails to write without throwing", () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			// `point` is NOT NULL; an empty event is still valid, but a missing
			// model is not. The write must report failure, not throw into a turn.
			const broken = decisionFromResult("find", REQUEST, RESULT, { action: "auto" });
			broken.model = undefined as unknown as string;
			expect(() => ledger.append(broken)).not.toThrow();
		} finally {
			ledger.close();
		}
	});
});
