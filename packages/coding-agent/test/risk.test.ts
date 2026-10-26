/**
 * Risk assessment, as a safety contract.
 *
 * The property that matters is asymmetric: a signal may raise the risk, and a
 * judge may raise it further, but nothing may lower it below what code already
 * observed. These tests pin that direction, plus the specific shapes that must
 * always read as irreversible.
 */
import { describe, expect, it } from "bun:test";
import { assessRiskDeterministically, mergeJudgeRisk, riskReason, type RiskInput } from "../src/tools/risk";

const ROOT = "/repo/project";

function input(overrides: Partial<RiskInput> = {}): RiskInput {
	return { toolName: "bash", tier: "exec", args: {}, cwd: ROOT, ...overrides };
}

describe("assessRiskDeterministically", () => {
	it("reads a plain read-tier call as low risk", () => {
		const risk = assessRiskDeterministically(input({ toolName: "read", tier: "read", args: { path: "src/a.ts" } }));
		expect(risk.risk).toBe("read");
		expect(risk.score).toBeLessThan(0.3);
		expect(risk.signals).toHaveLength(0);
	});

	it("floors a write at write risk even with no signal", () => {
		const risk = assessRiskDeterministically(input({ toolName: "write", tier: "write", args: { path: "src/a.ts" } }));
		expect(risk.risk).toBe("write");
		expect(risk.score).toBeGreaterThanOrEqual(0.45);
	});

	it("calls a recursive forced delete irreversible", () => {
		const risk = assessRiskDeterministically(input({ args: { command: "rm -rf build/" } }));
		expect(risk.risk).toBe("irreversible");
		expect(risk.signals.some(s => s.id === "rm-recursive")).toBe(true);
	});

	it("flags a home or root delete above a build delete", () => {
		const home = assessRiskDeterministically(input({ args: { command: "rm -rf ~/" } }));
		const build = assessRiskDeterministically(input({ args: { command: "rm -rf build/" } }));
		expect(home.score).toBeGreaterThan(build.score);
	});

	it("flags a hard reset, a force push, and a database drop", () => {
		for (const [command, id] of [
			["git reset --hard HEAD~3", "git-reset-hard"],
			["git push origin main --force", "force-push"],
			["psql -c 'DROP TABLE users'", "drop-table"],
		] as const) {
			const risk = assessRiskDeterministically(input({ args: { command } }));
			expect(risk.signals.some(s => s.id === id)).toBe(true);
		}
	});

	it("treats a delete tool as irreversible whatever it is called on", () => {
		const risk = assessRiskDeterministically(input({ toolName: "delete", tier: "write", args: { path: "tmp.txt" } }));
		expect(risk.risk).toBe("irreversible");
		expect(risk.reversible).toBe(false);
	});

	it("flags a path outside the session root", () => {
		const risk = assessRiskDeterministically(
			input({ toolName: "write", tier: "write", args: { path: "/etc/passwd" } }),
		);
		expect(risk.signals.some(s => s.id === "outside-root")).toBe(true);
	});

	it("does not flag a path inside the session root", () => {
		const risk = assessRiskDeterministically(
			input({ toolName: "write", tier: "write", args: { path: "src/deep/file.ts" } }),
		);
		expect(risk.signals.some(s => s.id === "outside-root")).toBe(false);
	});

	it("does not flag a sibling directory that merely shares a prefix", () => {
		// `/repo/project-two` starts with `/repo/project` but is a different tree.
		const risk = assessRiskDeterministically(
			input({ toolName: "write", tier: "write", args: { path: "/repo/project-two/file.ts" } }),
		);
		expect(risk.signals.some(s => s.id === "outside-root")).toBe(true);
	});

	it("flags an exec call whose code cannot be inspected", () => {
		const risk = assessRiskDeterministically(input({ args: { something: "else" } }));
		expect(risk.signals.some(s => s.id === "opaque-exec")).toBe(true);
	});

	it("notes an existing grant as the mildest signal", () => {
		const risk = assessRiskDeterministically(
			input({ toolName: "write", tier: "write", args: { path: "a.ts" }, granted: true }),
		);
		expect(risk.signals.some(s => s.id === "granted")).toBe(true);
	});

	it("orders signals strongest first", () => {
		const risk = assessRiskDeterministically(input({ args: { command: "sudo rm -rf /" } }));
		expect(risk.signals[0].weight).toBeGreaterThanOrEqual(risk.signals[1]?.weight ?? 0);
	});
});

describe("mergeJudgeRisk", () => {
	it("raises the score when the judge is more alarmed than code", () => {
		const base = assessRiskDeterministically(input({ toolName: "write", tier: "write", args: { path: "a.ts" } }));
		const merged = mergeJudgeRisk(base, { score: 3, confidence: 0.8 });

		expect(merged.score).toBeGreaterThan(base.score);
		expect(merged.judgeScore).toBe(1);
		expect(merged.judged).toBe(true);
	});

	it("never lowers the score below the deterministic finding", () => {
		const base = assessRiskDeterministically(input({ args: { command: "rm -rf ~/" } }));
		const merged = mergeJudgeRisk(base, { score: 0, confidence: 0.9 });

		expect(merged.score).toBe(base.score);
		expect(merged.risk).toBe(base.risk);
	});

	it("never clears an irreversible finding", () => {
		const base = assessRiskDeterministically(input({ toolName: "delete", tier: "write", args: { path: "x" } }));
		const merged = mergeJudgeRisk(base, { score: 0, confidence: 1 });

		expect(merged.risk).toBe("irreversible");
		expect(merged.reversible).toBe(false);
	});

	it("promotes to irreversible when the judge finds the call must not run unattended", () => {
		const base = assessRiskDeterministically(input({ toolName: "write", tier: "write", args: { path: "a.ts" } }));
		const merged = mergeJudgeRisk(base, { score: 3 });

		expect(merged.risk).toBe("irreversible");
	});
});

describe("riskReason", () => {
	it("states the observed signals rather than a generated sentence", () => {
		const base = assessRiskDeterministically(input({ args: { command: "rm -rf build/" } }));
		expect(riskReason(base)).toContain("recursive forced delete");
	});

	it("names the model rating as a rating when it raised the score", () => {
		const base = assessRiskDeterministically(input({ toolName: "write", tier: "write", args: { path: "a.ts" } }));
		const merged = mergeJudgeRisk(base, { score: 2 });
		expect(riskReason(merged)).toContain("model review");
	});
});
