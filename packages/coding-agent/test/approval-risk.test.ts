/**
 * The approval dialog's risk rows, and what they must not change.
 *
 * The risk read is advisory. These tests pin both halves: the dialog states
 * the score, the reversibility, and the observed reason, and an approval still
 * happens only on an explicit yes — a high score never becomes a yes, and a low
 * one never becomes a silent allow.
 */
import { describe, expect, it } from "bun:test";
import { approvalDecision, assessRiskDeterministically, mergeJudgeRisk } from "../src/tools/risk";
import { formatApprovalPrompt, requestApproval } from "../src/tools/approval";

/** The slice of a tool the prompt builders read. */
type ApprovalSubject = Parameters<typeof formatApprovalPrompt>[0];

const BASH: ApprovalSubject = {
	name: "bash",
	approval: "exec",
	formatApprovalDetails: (args: unknown) => [`Command: ${(args as { command?: string }).command ?? ""}`],
};

describe("approval prompt risk block", () => {
	it("names the risk class, the score, and the reversibility", () => {
		const risk = assessRiskDeterministically({
			toolName: "bash",
			tier: "exec",
			args: { command: "rm -rf build/" },
			cwd: "/repo",
		});
		const prompt = formatApprovalPrompt(BASH, { command: "rm -rf build/" }, undefined, risk);

		expect(prompt).toContain("Risk: irreversible");
		expect(prompt).toContain("Reversible: no");
		expect(prompt).toContain("Why:");
		expect(prompt).toContain("recursive forced delete");
	});

	it("marks a routine write as reversible", () => {
		const risk = assessRiskDeterministically({
			toolName: "write",
			tier: "write",
			args: { path: "src/a.ts" },
			cwd: "/repo",
		});
		const prompt = formatApprovalPrompt({ name: "write", approval: "write" }, { path: "src/a.ts" }, undefined, risk);
		expect(prompt).toContain("Reversible: yes");
	});

	it("states the model's rating separately from the observations", () => {
		const base = assessRiskDeterministically({
			toolName: "write",
			tier: "write",
			args: { path: "src/a.ts" },
			cwd: "/repo",
		});
		const merged = mergeJudgeRisk(base, { score: 2, confidence: 0.7 });
		const prompt = formatApprovalPrompt(
			{ name: "write", approval: "write" },
			{ path: "src/a.ts" },
			undefined,
			merged,
		);

		expect(prompt).toContain("model");
	});

	it("leaves the prompt unchanged when no risk was computed", () => {
		const prompt = formatApprovalPrompt(BASH, { command: "ls" });
		expect(prompt).not.toContain("Risk:");
	});
});

describe("requestApproval", () => {
	it("carries the risk rows into the dialog the host receives", async () => {
		const seen: { full: string; compact: string }[] = [];
		const risk = assessRiskDeterministically({
			toolName: "bash",
			tier: "exec",
			args: { command: "rm -rf build/" },
			cwd: "/repo",
		});

		await requestApproval(
			{
				select: async () => "Approve",
				approve: async prompt => {
					seen.push({ full: prompt.full, compact: prompt.compact });
					return "once";
				},
			},
			BASH,
			{ command: "rm -rf build/" },
			{ risk },
		);

		expect(seen[0].full).toContain("Risk: irreversible");
		expect(seen[0].compact).toContain("Risk: irreversible");
	});

	it("denies when the host gives anything but an explicit approval", async () => {
		const risk = assessRiskDeterministically({
			toolName: "bash",
			tier: "exec",
			args: { command: "ls" },
			cwd: "/repo",
		});
		const answer = await requestApproval(
			{ select: async () => "Deny", approve: async () => "deny" },
			BASH,
			{ command: "ls" },
			{ risk },
		);
		expect(answer).toBe("deny");
	});

	it("does not let a low risk score approve on its own", async () => {
		// A read-tier call with no signals: the dialog still has to be answered.
		const risk = assessRiskDeterministically({
			toolName: "read",
			tier: "read",
			args: { path: "a.ts" },
			cwd: "/repo",
		});
		let asked = false;
		await requestApproval(
			{
				select: async () => "Approve",
				approve: async () => {
					asked = true;
					return "once";
				},
			},
			{ name: "read", approval: "read" },
			{ path: "a.ts" },
			{ risk },
		);
		expect(asked).toBe(true);
	});
});

describe("approvalDecision", () => {
	it("records an approval as gated and a denial as blocked", () => {
		const risk = assessRiskDeterministically({
			toolName: "bash",
			tier: "exec",
			args: { command: "rm -rf build/" },
			cwd: "/repo",
		});
		const approved = approvalDecision("bash", "exec", risk, true, "once");
		const denied = approvalDecision("bash", "exec", risk, false, "deny");

		expect(approved.action).toBe("gated");
		expect(denied.action).toBe("blocked");
		expect(approved.risk).toBe("irreversible");
		expect(approved.reason).toContain("approved once");
		expect(denied.reason).toContain("denied");
	});

	it("names the grant a remembered answer recorded", () => {
		const risk = assessRiskDeterministically({
			toolName: "write",
			tier: "write",
			args: { path: "a.ts" },
			cwd: "/repo",
		});
		const event = approvalDecision("write", "write", risk, true, { grant: "write:a.ts", always: true });
		expect(event.reason).toContain("granted write:a.ts (always)");
	});

	it("carries the risk score as a 0–3 level", () => {
		const risk = assessRiskDeterministically({
			toolName: "bash",
			tier: "exec",
			args: { command: "ls" },
			cwd: "/repo",
		});
		const event = approvalDecision("bash", "exec", risk, true, "once");
		expect(event.answers[0].type).toBe("score");
		expect(Number(event.answers[0].value)).toBeGreaterThanOrEqual(0);
		expect(Number(event.answers[0].value)).toBeLessThanOrEqual(3);
	});
});
