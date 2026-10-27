/**
 * The decision renderers' contract.
 *
 * Two things must hold for the transcript to be trustworthy: a line stays one
 * row whatever the answer carries, and a card shows the distribution rather
 * than only the chosen label. The ledger stores the same event, so these tests
 * double as a check that what is drawn matches what was recorded.
 */
import { describe, expect, it } from "bun:test";
import type { DecisionEvent } from "@ngodeai/ai";
import { initTheme } from "../src/theme";
import {
	DecisionCard,
	DecisionLine,
	createDecisionComponent,
	pointLabel,
	probabilityBar,
} from "../src/chat/decision-message";
import { plainText } from "../src/native/spans";

await initTheme();

function event(overrides: Partial<DecisionEvent> = {}): DecisionEvent {
	return {
		id: 7,
		at: Date.now(),
		point: "tool_approval",
		model: "jev-1.14.0",
		api: "typesafe",
		provider: "typesafe",
		questions: [
			{
				id: "allowed",
				type: "choice",
				instructions: "May this command run?",
				criteria: { allow: "safe", ask: "needs a human", deny: "destructive" },
			},
		],
		answers: [
			{
				question: "allowed",
				type: "choice",
				value: "ask",
				probabilities: { allow: 0.24, ask: 0.71, deny: 0.05 },
				confidence: 0.565,
			},
		],
		action: "gated",
		tier: "line",
		confidence: 0.565,
		elapsedMs: 38,
		cost: 0.0000173,
		...overrides,
	};
}

describe("probabilityBar", () => {
	it("fills in proportion to the value", () => {
		expect(probabilityBar(1, 1, 10)).toBe("██████████");
		expect(probabilityBar(0.5, 1, 10)).toBe("█████░░░░░");
		expect(probabilityBar(0, 1, 10)).toBe("░░░░░░░░░░");
	});

	it("clamps out-of-range input rather than throwing", () => {
		expect(probabilityBar(2, 1, 4)).toBe("████");
		expect(probabilityBar(-1, 1, 4)).toBe("░░░░");
		expect(probabilityBar(0.5, 0, 4)).toBe("░░░░");
	});
});

describe("pointLabel", () => {
	it("reads a point id as words", () => {
		expect(pointLabel("tool_approval")).toBe("tool approval");
		expect(pointLabel("ttsr")).toBe("ttsr");
	});
});

describe("DecisionLine", () => {
	it("renders one row naming the action, the point, and the answer", () => {
		const line = new DecisionLine(event());
		const rows = line.render(120);
		const text = plainText(rows.join("\n"));

		expect(rows).toHaveLength(1);
		expect(text).toContain("gated");
		expect(text).toContain("tool approval");
		expect(text).toContain("ask");
		expect(text).toContain("0.71");
	});

	it("stays one row at a narrow width", () => {
		// A narrow terminal clips the row; it must not wrap into a paragraph.
		expect(new DecisionLine(event()).render(40)).toHaveLength(1);
	});

	it("names the reason when the caller gave one", () => {
		const text = plainText(
			new DecisionLine(event({ reason: "confidence under the write threshold" })).render(160).join("\n"),
		);
		expect(text).toContain("confidence under the write threshold");
	});

	it("flags a disagreement with code", () => {
		const text = plainText(new DecisionLine(event({ conflict: "typecheck failed" })).render(160).join("\n"));
		expect(text).toContain("typecheck failed");
	});
});

describe("DecisionCard", () => {
	it("shows the chosen answer and its probability collapsed", () => {
		const rows = new DecisionCard(event({ tier: "card" })).render(100);
		const text = plainText(rows.join("\n"));

		expect(text).toContain("DECIDE");
		expect(text).toContain("ask");
		expect(text).toContain("0.71");
	});

	it("adds provenance when expanded", () => {
		const text = plainText(new DecisionCard(event({ tier: "card" }), true).render(120).join("\n"));
		expect(text).toContain("jev-1.14.0");
		expect(text).toContain("typesafe");
	});

	it("says when the answer came from cache", () => {
		const text = plainText(new DecisionCard(event({ tier: "card", cached: true }), true).render(120).join("\n"));
		expect(text).toContain("cache");
	});

	// The card must name the backend the ledger recorded. An earlier revision
	// rewrote every `jev-*` answer to `mercury-decide`, which made the transcript
	// disagree with `/decisions` and hid which route was billed.
	it("names the decision model that actually answered", () => {
		const jev = plainText(
			new DecisionCard(event({ tier: "card", model: "ngodeai/jev-1.14" })).render(120).join("\n"),
		);
		expect(jev).toContain("jev-1.14");
		expect(jev).not.toContain("mercury-decide");

		const mercury = plainText(
			new DecisionCard(event({ tier: "card", model: "ngodeai/mercury-decide" })).render(120).join("\n"),
		);
		expect(mercury).toContain("mercury-decide");
	});

	it("omits a model it was not told about instead of inventing one", () => {
		const text = plainText(new DecisionCard(event({ tier: "card", model: "" })).render(120).join("\n"));
		expect(text).not.toContain("mercury-decide");
	});

	it("elides answers past the collapsed limit and says how many", () => {
		const many = event({
			tier: "card",
			questions: Array.from({ length: 9 }, (_, i) => ({
				id: `q${i}`,
				type: "noul" as const,
				instructions: `q${i}`,
			})),
			answers: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, type: "noul" as const, value: 0.9 })),
		});
		const text = plainText(new DecisionCard(many).render(120).join("\n"));
		expect(text).toContain("4 more");
	});

	it("shows every answer when expanded", () => {
		const many = event({
			tier: "card",
			questions: Array.from({ length: 9 }, (_, i) => ({
				id: `q${i}`,
				type: "noul" as const,
				instructions: `q${i}`,
			})),
			answers: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, type: "noul" as const, value: 0.9 })),
		});
		const text = plainText(new DecisionCard(many, true).render(120).join("\n"));
		expect(text).not.toContain("more");
	});
});

describe("createDecisionComponent", () => {
	it("picks the card for a card tier and the line otherwise", () => {
		expect(createDecisionComponent(event({ tier: "card" }))).toBeInstanceOf(DecisionCard);
		expect(createDecisionComponent(event({ tier: "line" }))).toBeInstanceOf(DecisionLine);
	});
});
