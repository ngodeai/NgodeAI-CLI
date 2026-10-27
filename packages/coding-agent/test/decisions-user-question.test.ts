/**
 * A question answered by a human is a decision.
 *
 * `ask` was invisible to the ledger: the layer held only what the machine
 * decided, so a session that mostly asked questions reported "No decisions
 * recorded yet" even though a person had answered several. These pin the two
 * halves of the fix — the point is declared, and a recorded event reaches the
 * ledger as a gated decision.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@ngodeai/utils";
import type { DecisionEvent } from "@ngodeai/ai";
import { DECISION_POINTS, DecisionLayer, DecisionLedger } from "../src/judgment";

/** The event shape `recordAskDecision` builds, in the fields that matter here. */
function askEvent(): DecisionEvent {
	return {
		at: 1_700_000_000_000,
		point: "user_question",
		model: "human",
		api: "ask",
		provider: "local",
		questions: [
			{
				id: "format",
				type: "choice",
				instructions: "Format laporan?",
				criteria: { Tabel: null, Poin: null, Prosa: null },
			},
		],
		answers: [
			{
				question: "format",
				type: "choice",
				value: "Tabel",
				probabilities: { Tabel: 1 },
				confidence: 1,
			},
		],
		action: "gated",
		tier: "line",
		risk: "read",
		decisionKeys: ["format"],
		reason: "answered: Tabel",
	};
}

describe("user_question", () => {
	it("is a shipped decision point", () => {
		expect(DECISION_POINTS).toContain("user_question");
	});

	it("reaches the ledger and counts as gated", () => {
		using tempDir = TempDir.createSync("@ngodeai-user-question-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		const emitted: DecisionEvent[] = [];
		const layer = DecisionLayer.open({ ledger, sessionId: "s", emit: e => emitted.push(e) });
		try {
			layer.record(askEvent());

			const rows = ledger.list({ session: "s" });
			expect(rows).toHaveLength(1);
			expect(rows[0]!.point).toBe("user_question");
			expect(rows[0]!.action).toBe("gated");
			expect(rows[0]!.answers[0]!.value).toBe("Tabel");

			// A human answered, so the row is shown and the status line counts it
			// in the gated half — the part of the session someone had to act on.
			expect(emitted).toHaveLength(1);
			expect(layer.counts.count).toBe(1);
			expect(layer.counts.gated).toBe(1);
		} finally {
			ledger.close();
		}
	});

	it("keeps the answer readable in `/decisions` detail", () => {
		using tempDir = TempDir.createSync("@ngodeai-user-question-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		const layer = DecisionLayer.open({ ledger, sessionId: "s" });
		try {
			layer.record(askEvent());
			const id = ledger.list({ session: "s" })[0]!.id!;
			const stored = layer.get(id);
			expect(stored?.questions[0]!.instructions).toBe("Format laporan?");
			expect(stored?.reason).toBe("answered: Tabel");
		} finally {
			ledger.close();
		}
	});

	/**
	 * `record` stamps the session id.
	 *
	 * Every read path filters by session, so an event recorded without one lands
	 * under `NULL` and the ledger reads as empty — which is exactly how a
	 * session that answered questions and approved tool calls reported "No
	 * decisions recorded yet". The same hole hit `approvalDecision`, which never
	 * set the field.
	 */
	it("stamps the layer's session id on a recorded event", () => {
		using tempDir = TempDir.createSync("@ngodeai-user-question-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		const layer = DecisionLayer.open({ ledger, sessionId: "session-a" });
		try {
			layer.record(askEvent());
			expect(ledger.list({ session: "session-a" })).toHaveLength(1);
			expect(ledger.list({ session: "someone-else" })).toHaveLength(0);
		} finally {
			ledger.close();
		}
	});

	it("does not overwrite a session id the caller supplied", () => {
		using tempDir = TempDir.createSync("@ngodeai-user-question-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		const layer = DecisionLayer.open({ ledger, sessionId: "layer-session" });
		try {
			layer.record({ ...askEvent(), sessionId: "caller-session" });
			expect(ledger.list({ session: "caller-session" })).toHaveLength(1);
			expect(ledger.list({ session: "layer-session" })).toHaveLength(0);
		} finally {
			ledger.close();
		}
	});
});
