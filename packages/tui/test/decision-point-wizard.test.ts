/**
 * The authoring wizard's one job: write a file the loader accepts.
 *
 * The criteria *shape* is what decides a question's type, so the property
 * worth pinning is that each kind serializes to the shape its type needs —
 * and that a yes/no writes no criteria at all, because an empty criteria
 * object would read as a choice with no options.
 */
import { describe, expect, it } from "bun:test";
import { decisionPointJson, type DecisionPointDraft } from "../src/overlays/decision-point-wizard";

function draft(overrides: Partial<DecisionPointDraft> = {}): DecisionPointDraft {
	return {
		id: "release-ready",
		kind: "yesno",
		instruction: "Does `state.diff` include a changelog entry?",
		labels: [],
		risk: "read",
		...overrides,
	};
}

describe("decisionPointJson", () => {
	it("writes a yes/no question with no criteria", () => {
		const file = JSON.parse(decisionPointJson(draft()));
		expect(file.questions.decision.criteria).toBeUndefined();
		expect(file.questions.decision.instructions).toContain("changelog");
	});

	it("writes a score's levels as an array, lowest first", () => {
		const file = JSON.parse(decisionPointJson(draft({ kind: "score", labels: ["none", "partial", "complete"] })));
		expect(file.questions.decision.criteria).toEqual(["none", "partial", "complete"]);
	});

	it("writes a choice's options as a label map", () => {
		const file = JSON.parse(decisionPointJson(draft({ kind: "choice", labels: ["allow", "ask", "deny"] })));
		expect(file.questions.decision.criteria).toEqual({ allow: null, ask: null, deny: null });
	});

	it("gives a read point a threshold and an irreversible one none", () => {
		expect(JSON.parse(decisionPointJson(draft({ risk: "read" }))).autoThreshold).toBe(0.85);
		expect(JSON.parse(decisionPointJson(draft({ risk: "write" }))).autoThreshold).toBe(0.95);
		// An irreversible point has no threshold: it never auto-approves.
		expect(JSON.parse(decisionPointJson(draft({ risk: "irreversible" }))).autoThreshold).toBeUndefined();
	});

	it("turns the id into a readable label", () => {
		const file = JSON.parse(decisionPointJson(draft({ id: "release-ready" })));
		expect(file.label).toBe("Release Ready");
	});

	it("produces JSON with a trailing newline, so the file is diff-friendly", () => {
		expect(decisionPointJson(draft()).endsWith("\n")).toBe(true);
	});

	it("round-trips through the loader's own parser", async () => {
		const { parseDecisionPoint } = await import("@ngodeai/coding-agent/judgment");
		const file = JSON.parse(decisionPointJson(draft({ kind: "score", labels: ["none", "partial", "complete"] })));
		const point = parseDecisionPoint("release-ready", file, "test");
		expect(point.risk).toBe("read");
		expect(point.questions.decision.type).toBe("score");
		expect(point.autoThreshold).toBe(0.85);
	});
});
