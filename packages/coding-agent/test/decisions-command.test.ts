/**
 * `/decisions` renders what the ledger holds.
 *
 * The command is the only way to read a decision's state after the fact, so
 * the contract worth testing is that it never invents a summary: every number
 * it prints comes from a stored event, and a decision with no state says so
 * instead of printing an empty block.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@ngodeai/utils";
import { decisionFromResult, type JudgmentRequest, type JudgmentResult } from "@ngodeai/ai";
import { DecisionLayer, DecisionLedger } from "../src/judgment";
import { initTheme } from "@ngodeai/tui/theme";
import { decisionSlashCommands } from "../src/slash-commands/builtin-decisions";

await initTheme();

const REQUEST: JudgmentRequest = {
	state: { command: "rm -rf build/" },
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

/** A session stub exposing only what the command reads. */
function fakeSession(ledger: DecisionLedger) {
	const layer = DecisionLayer.open({ ledger, emit: undefined });
	return {
		decisions: layer,
	} as unknown as Parameters<NonNullable<(typeof decisionSlashCommands)[0]["handle"]>>[1]["session"];
}

async function run(args: string, ledger: DecisionLedger): Promise<string> {
	const outputs: string[] = [];
	const handle = decisionSlashCommands[0].handle!;
	await handle({ name: "decisions", args, text: `/decisions ${args}` }, {
		session: fakeSession(ledger),
		output: (text: string) => {
			outputs.push(text);
		},
	} as Parameters<typeof handle>[1]);
	return outputs.join("\n");
}

describe("/decisions", () => {
	it("says so when nothing has been recorded", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-cmd-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			expect(await run("", ledger)).toContain("No decisions recorded");
		} finally {
			ledger.close();
		}
	});

	it("lists a decision with its point, answer, and action", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-cmd-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			ledger.append(
				decisionFromResult(
					"tool_approval",
					REQUEST,
					RESULT,
					{ action: "gated", reason: "under threshold" },
					{ sessionId: "s" },
				),
			);
			const text = await run("", ledger);
			expect(text).toContain("tool approval");
			expect(text).toContain("ask");
			// The list column shows the answer's confidence, not its probability:
			// confidence is the number a threshold is compared against.
			expect(text).toContain("0.56");
			expect(text).toContain("gated");
		} finally {
			ledger.close();
		}
	});

	it("shows the state when it was kept", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-cmd-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			const id = ledger.append(
				decisionFromResult(
					"tool_approval",
					REQUEST,
					RESULT,
					{ action: "gated", keepState: true },
					{ sessionId: "s" },
				),
			)!;
			const text = await run(String(id), ledger);
			expect(text).toContain("rm -rf build/");
			expect(text).toContain("May this command run?");
			// The detail view prints every option's probability, not just the winner.
			expect(text).toContain("allow");
			expect(text).toContain("0.24");
		} finally {
			ledger.close();
		}
	});

	it("says the state was not kept rather than printing an empty block", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-cmd-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			const id = ledger.append(
				decisionFromResult("tool_approval", REQUEST, RESULT, { action: "gated" }, { sessionId: "s" }),
			)!;
			const text = await run(String(id), ledger);
			expect(text).toContain("state digest");
			expect(text).toContain("not kept");
		} finally {
			ledger.close();
		}
	});

	it("prints the threshold matrix", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-cmd-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			const text = await run("status", ledger);
			expect(text).toContain("Gate thresholds");
			expect(text).toContain("never");
			expect(text).toContain("Irreversible actions never auto-approve");
		} finally {
			ledger.close();
		}
	});

	it("summarises per point", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-cmd-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			ledger.append(decisionFromResult("ttsr", REQUEST, RESULT, { action: "silent" }, { sessionId: "s" }));
			ledger.append(decisionFromResult("ttsr", REQUEST, RESULT, { action: "silent" }, { sessionId: "s" }));
			const text = await run("points", ledger);
			expect(text).toContain("ttsr");
			expect(text).toContain("2");
		} finally {
			ledger.close();
		}
	});

	it("lists only conflicts under `conflicts`", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-cmd-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			ledger.append(decisionFromResult("find", REQUEST, RESULT, { action: "auto" }, { sessionId: "s" }));
			ledger.append(
				decisionFromResult(
					"verify_edit",
					REQUEST,
					RESULT,
					{ action: "auto", conflict: "typecheck failed" },
					{ sessionId: "s" },
				),
			);
			const text = await run("conflicts", ledger);
			expect(text).toContain("verify edit");
			expect(text).not.toContain("find");
		} finally {
			ledger.close();
		}
	});

	it("reports an unknown id instead of failing", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-cmd-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			expect(await run("999", ledger)).toContain("No decision #999");
		} finally {
			ledger.close();
		}
	});
});

describe("/decisions new", () => {
	it("writes a starter point file under the project", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-new-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			const outputs: string[] = [];
			const handle = decisionSlashCommands[0].handle!;
			await handle({ name: "decisions", args: "new release-ready", text: "/decisions new release-ready" }, {
				session: fakeSession(ledger),
				cwd: tempDir.path(),
				output: (text: string) => {
					outputs.push(text);
				},
			} as Parameters<typeof handle>[1]);

			const file = path.join(tempDir.path(), ".ngodeai", "decisions", "release-ready.json");
			expect(fs.existsSync(file)).toBe(true);
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			expect(parsed.questions).toBeDefined();
			expect(outputs.join("\n")).toContain("Created");
		} finally {
			ledger.close();
		}
	});

	it("refuses to overwrite an existing point", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-new-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			const dir = path.join(tempDir.path(), ".ngodeai", "decisions");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "taken.json"), "{}");
			const outputs: string[] = [];
			const handle = decisionSlashCommands[0].handle!;
			await handle({ name: "decisions", args: "new taken", text: "/decisions new taken" }, {
				session: fakeSession(ledger),
				cwd: tempDir.path(),
				output: (text: string) => {
					outputs.push(text);
				},
			} as Parameters<typeof handle>[1]);
			expect(outputs.join("\n")).toContain("already exists");
		} finally {
			ledger.close();
		}
	});

	it("rejects a name with path separators", async () => {
		using tempDir = TempDir.createSync("@ngodeai-decisions-new-");
		const ledger = DecisionLedger.open(path.join(tempDir.path(), "decisions.db"));
		try {
			const outputs: string[] = [];
			const handle = decisionSlashCommands[0].handle!;
			await handle({ name: "decisions", args: "new ../escape", text: "/decisions new ../escape" }, {
				session: fakeSession(ledger),
				cwd: tempDir.path(),
				output: (text: string) => {
					outputs.push(text);
				},
			} as Parameters<typeof handle>[1]);
			expect(outputs.join("\n")).toContain("may contain letters");
		} finally {
			ledger.close();
		}
	});
});
