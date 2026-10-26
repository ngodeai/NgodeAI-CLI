/**
 * `/decisions` — the Artificial Decisions ledger, as a command.
 *
 * Four shapes:
 *
 * - `/decisions` — the session's decisions, newest first, with a header that
 *   totals what they cost and a footer that names the next moves.
 * - `/decisions status` — the layer's own configuration: backend, cache, and
 *   the confidence matrix, because a threshold nobody can read is a threshold
 *   nobody can tune.
 * - `/decisions <id>` — one decision in full, including the state the judge
 *   saw. This is the surface that makes a wrong answer debuggable: either the
 *   model misread a good state, or the state was missing something.
 * - `/decisions points` — per-point aggregates, so a session's spend can be
 *   attributed to the decisions that caused it.
 *
 * The output is plain text through `runtime.output`, which every host renders
 * (TUI transcript, print mode, ACP). A selector UI would be nicer for the list
 * and is a later step; a table that works everywhere is the right first shape.
 */
import { formatDuration, formatNumber } from "@ngodeai/utils";
import type { DecisionEvent, JudgmentState } from "@ngodeai/ai";
import { reportTask } from "../judgment/benchmark";
import type { DecisionTotals } from "../judgment/ledger";
import { pointLabel, probabilityBar } from "@ngodeai/tui/chat/decision-message";
import { theme } from "@ngodeai/tui/theme";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession } from "../session/agent-session";
import { commandConsumed, parseSubcommand } from "./helpers/parse";
import type { SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";
import { DecisionPointWizard, decisionPointJson } from "@ngodeai/tui/overlays/decision-point-wizard";
import { clearSubmittedText } from "./helpers/draft";

/** Rows shown by a bare `/decisions` before the footer suggests paging. */
const LIST_LIMIT = 25;

/** `12:04:31` in the host's local time. */
function clock(at: number): string {
	return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

/** `$0.000017` — decisions are cheap enough that a coarse format reads as zero. */
function cost(usd: number | undefined): string {
	if (!usd) return "—";
	return usd < 0.0001 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(5)}`;
}

/** The answer the row leads with: the one the caller keyed on, else the first. */
function leadAnswer(event: DecisionEvent) {
	if (event.decisionKeys?.length) {
		return event.answers.find(answer => event.decisionKeys!.includes(answer.question)) ?? event.answers[0];
	}
	return event.answers[0];
}

/** `ask 0.71` for a choice, `yes 0.98` for a noul, the level for a score. */
function answerSummary(event: DecisionEvent): string {
	const answer = leadAnswer(event);
	if (!answer) return "—";
	if (answer.type === "noul") {
		const p = Number(answer.value);
		return `${p >= 0.5 ? "yes" : "no"} ${p.toFixed(2)}`;
	}
	const confidence = answer.confidence;
	return confidence === undefined ? String(answer.value) : `${answer.value} ${confidence.toFixed(2)}`;
}

/** Pad or clip to `width`, so the columns line up whatever the content is. */
function cell(value: string, width: number): string {
	const plain = Bun.stripANSI(value);
	if (plain.length > width) return `${plain.slice(0, Math.max(0, width - 1))}…`;
	return value + " ".repeat(width - plain.length);
}

function renderList(events: readonly DecisionEvent[], totals: DecisionTotals): string {
	if (events.length === 0) {
		return [
			theme.fg("muted", "  No decisions recorded yet."),
			theme.fg("dim", "  Decisions appear here as the agent routes, verifies, and gates its work."),
		].join("\n");
	}
	const lines: string[] = [];
	lines.push(
		theme.fg(
			"dim",
			`  /decisions · ${formatNumber(totals.count)} this session · ${cost(totals.cost)} · ${formatDuration(totals.elapsedMs)} · ${totals.gated} gated`,
		),
	);
	lines.push(theme.fg("dim", `  ${"─".repeat(76)}`));
	for (const event of events) {
		const time = theme.fg("dim", clock(event.at));
		const id = theme.fg("dim", String(event.id ?? "").padStart(4));
		const point = theme.fg("text", cell(pointLabel(event.point), 16));
		const answer = theme.fg("text", cell(answerSummary(event), 12));
		const action = theme.fg(
			event.action === "blocked" ? "error" : event.action === "gated" ? "warning" : "dim",
			cell(event.action, 8),
		);
		const conflict = event.conflict ? theme.fg("error", " ⚠") : "  ";
		lines.push(`  ${time} ${id} ${point} ${answer} ${action} ${cost(event.cost).padStart(11)}${conflict}`);
	}
	lines.push(theme.fg("dim", `  ${"─".repeat(76)}`));
	lines.push(theme.fg("dim", "  /decisions <id> detail · status · points · conflicts · replay <id>"));
	return lines.join("\n");
}

function renderDetail(event: DecisionEvent): string {
	const lines: string[] = [];
	lines.push(theme.fg("text", theme.bold(`  ${pointLabel(event.point)}`)) + theme.fg("dim", ` · #${event.id ?? "?"}`));
	lines.push(
		theme.fg(
			"dim",
			`  ${clock(event.at)} · ${event.model} via ${event.api} · ${formatDuration(event.elapsedMs ?? 0)}`,
		),
	);
	lines.push("");
	const answer = leadAnswer(event);
	const confidence =
		answer?.confidence ?? (answer?.type === "noul" ? Math.abs(2 * Number(answer.value) - 1) : undefined);
	if (confidence !== undefined) {
		const bar = probabilityBar(confidence, 1, 30);
		lines.push(
			`  confidence  ${theme.fg(event.action === "blocked" ? "error" : "accent", bar)} ${confidence.toFixed(2)}`,
		);
	}
	lines.push(`  outcome     ${event.action}${event.reason ? theme.fg("dim", ` · ${event.reason}`) : ""}`);
	if (event.conflict) lines.push(`  ${theme.fg("error", `⚠ ${event.conflict}`)}`);
	if (event.cached)
		lines.push(theme.fg("dim", `  served from the answer cache (${event.cachedQuestions ?? 0} questions)`));
	lines.push("");

	lines.push(theme.fg("dim", "  questions and answers"));
	for (const question of event.questions) {
		const answered = event.answers.find(a => a.question === question.id);
		lines.push(`  ${theme.fg("muted", question.id)}  ${theme.fg("dim", `(${question.type})`)}`);
		lines.push(`    ${theme.fg("text", question.instructions)}`);
		if (!answered) continue;
		if (answered.probabilities) {
			for (const [label, p] of Object.entries(answered.probabilities)) {
				const bar = probabilityBar(p, 1, 24);
				const mark = label === String(answered.value) ? theme.fg("accent", "▸") : " ";
				lines.push(`    ${mark} ${cell(label, 12)} ${theme.fg("dim", bar)} ${p.toFixed(2)}`);
			}
		} else {
			lines.push(`    → ${String(answered.value)}`);
		}
	}

	if (event.state !== undefined) {
		lines.push("");
		lines.push(theme.fg("dim", "  state"));
		const state = JSON.stringify(event.state, null, 2) ?? "null";
		for (const line of state.split("\n").slice(0, 40)) lines.push(theme.fg("dim", `    ${line}`));
		if (state.split("\n").length > 40) lines.push(theme.fg("dim", "    …"));
	} else if (event.stateDigest) {
		lines.push("");
		lines.push(
			theme.fg("dim", `  state digest ${event.stateDigest.slice(0, 16)} (not kept; enable decisions.keepState)`),
		);
	}
	return lines.join("\n");
}

function renderStatus(session: AgentSession): string {
	const layer = session.decisions;
	const totals = layer.totals();
	const thresholds = layer.thresholds;
	// The backend line names the model that will answer, and what it costs.
	// A free tier and a per-token tier look identical in a ledger otherwise,
	// and the whole point of preferring one is the price.
	// Optional on the session: hosts that predate the backend summary (and test
	// stubs) simply omit the row.
	const backend = session.judgeBackendSummary?.();
	const threshold = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : "never");
	const lines: string[] = [];
	lines.push(theme.fg("text", theme.bold("  Artificial Decisions")));
	lines.push(theme.fg("dim", `  ${"─".repeat(60)}`));
	lines.push(`  recording   ${layer.enabled ? theme.fg("success", "on") : theme.fg("muted", "off")}`);
	lines.push(`  ledger      ${layer.ledger ? theme.fg("success", "open") : theme.fg("muted", "unavailable")}`);
	lines.push(`  backend     ${backend ?? theme.fg("muted", "no judge resolved")}`);
	lines.push(
		`  this session ${formatNumber(totals.count)} decisions · ${cost(totals.cost)} · ${formatDuration(totals.elapsedMs)}`,
	);
	if (totals.count > 0) {
		const hitRate = Math.round((totals.cached / totals.count) * 100);
		lines.push(`  cache       ${hitRate}% of decisions answered wholly from cache`);
		lines.push(`  attention   ${totals.gated} gated · ${totals.conflicts} conflicts with code`);
	}
	lines.push("");
	lines.push(theme.fg("dim", "  Gate thresholds            read     write    irreversible"));
	lines.push(
		`  auto-allow            ${threshold(thresholds.read.auto).padStart(8)} ${threshold(thresholds.write.auto).padStart(9)} ${threshold(thresholds.irreversible.auto).padStart(13)}`,
	);
	lines.push(
		`  refuse below          ${threshold(thresholds.read.escalate).padStart(8)} ${threshold(thresholds.write.escalate).padStart(9)} ${threshold(thresholds.irreversible.escalate).padStart(13)}`,
	);
	lines.push("");
	lines.push(theme.fg("dim", "  Irreversible actions never auto-approve, whatever the threshold says."));
	return lines.join("\n");
}

function renderPoints(session: AgentSession): string {
	const points = session.decisions.points();
	// Optional on the session: hosts that predate user points (and test stubs)
	// simply declare none.
	const declared = session.userDecisionPoints ?? [];
	if (points.length === 0 && declared.length === 0) {
		return [
			theme.fg("muted", "  No decisions recorded yet."),
			theme.fg("dim", "  Declare a point in .ngodeai/decisions/<name>.json to add your own."),
		].join("\n");
	}
	const lines: string[] = [];
	lines.push(
		theme.fg(
			"dim",
			`  ${"point".padEnd(18)} ${"count".padStart(6)} ${"gated".padStart(6)} ${"mean conf".padStart(10)} ${"cost".padStart(12)}`,
		),
	);
	lines.push(theme.fg("dim", `  ${"─".repeat(58)}`));
	for (const point of points) {
		lines.push(
			`  ${cell(pointLabel(point.point), 18)} ${String(point.count).padStart(6)} ${String(point.gated).padStart(6)} ${(point.meanConfidence === undefined ? "—" : point.meanConfidence.toFixed(2)).padStart(10)} ${cost(point.cost).padStart(12)}`,
		);
	}
	if (declared.length > 0) {
		lines.push("");
		lines.push(theme.fg("dim", "  declared by this project"));
		for (const point of declared) {
			const auto = point.autoThreshold === undefined ? "class default" : point.autoThreshold.toFixed(2);
			const questions = Object.keys(point.questions).length;
			lines.push(
				`  ${cell(point.label ?? pointLabel(point.id), 18)} ${theme.fg("dim", `${point.risk} · auto ${auto} · ${questions} questions`)}`,
			);
		}
	}
	return lines.join("\n");
}

/** The starter file `/decisions new` writes: a working point the user edits. */
const NEW_POINT_TEMPLATE = `{
  "label": "My decision",
  "description": "What this decision changes, in one sentence.",
  "risk": "read",
  "autoThreshold": 0.85,
  "questions": {
    "example": {
      "instructions": "Ask one narrow question about the state, naming the fields it should read."
    }
  }
}
`;

/**
 * Launch the authoring wizard, replacing the editor until it finishes.
 *
 * Restoring the editor is the wizard's job on every exit path (create, cancel,
 * write failure), because a wizard that leaves the composer missing is a
 * session the user cannot type into.
 */
function launchDecisionWizard(runtime: TuiSlashCommandRuntime): void {
	const ctx = runtime.ctx;
	const existing = (ctx.session.userDecisionPoints ?? []).map(point => point.id);
	const done = () => {
		ctx.editorContainer.clear();
		ctx.editorContainer.addChild(ctx.editor);
		ctx.ui.setFocus(ctx.editor);
		ctx.ui.requestRender();
	};
	const wizard = new DecisionPointWizard({
		existing,
		requestRender: () => ctx.ui.requestRender(),
		onCancel: () => {
			done();
			ctx.showStatus("Decision point not created.");
		},
		onCreate: async draft => {
			const dir = path.join(ctx.sessionManager.getCwd(), ".ngodeai", "decisions");
			const file = path.join(dir, `${draft.id}.json`);
			if (fs.existsSync(file)) return `${draft.id} already exists.`;
			try {
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(file, decisionPointJson(draft), "utf8");
			} catch (error) {
				return `Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`;
			}
			done();
			ctx.showStatus(`Created ${file} · /reload-plugins to use it`);
			return undefined;
		},
	});
	ctx.editorContainer.clear();
	ctx.editorContainer.addChild(wizard);
	ctx.ui.setFocus(wizard.focusTarget);
	ctx.ui.requestRender();
}

async function handleNew(name: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const id = name.trim();
	if (id === "") {
		await runtime.output(theme.fg("muted", "  Usage: /decisions new <name>"));
		return commandConsumed({ failed: true });
	}
	if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
		await runtime.output(
			theme.fg(
				"error",
				"  A point name may contain letters, digits, and hyphens, and must start with a letter or digit.",
			),
		);
		return commandConsumed({ failed: true });
	}
	const dir = path.join(runtime.cwd, ".ngodeai", "decisions");
	const file = path.join(dir, `${id}.json`);
	if (fs.existsSync(file)) {
		await runtime.output(theme.fg("muted", `  ${file} already exists.`));
		return commandConsumed({ failed: true });
	}
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, NEW_POINT_TEMPLATE, "utf8");
	} catch (error) {
		await runtime.output(
			theme.fg("error", `  Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`),
		);
		return commandConsumed({ failed: true });
	}
	await runtime.output(
		[
			theme.fg("success", `  Created ${file}`),
			theme.fg("dim", "  Edit the questions, then run /decisions ask " + id + " with a state file."),
			theme.fg("dim", "  Reload with /reload-plugins to pick up the change."),
		].join("\n"),
	);
	return commandConsumed();
}

async function handleAsk(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const [id, ...stateParts] = rest.trim().split(/\s+/);
	if (!id) {
		await runtime.output(theme.fg("muted", "  Usage: /decisions ask <point> [state-file-or-json]"));
		return commandConsumed({ failed: true });
	}
	const session = runtime.session;
	const declared = (session.userDecisionPoints ?? []).find(point => point.id === id);
	if (!declared) {
		const known = (session.userDecisionPoints ?? []).map(point => point.id);
		await runtime.output(
			known.length === 0
				? theme.fg("muted", `  No point named "${id}". Declare one with /decisions new ${id}`)
				: theme.fg("muted", `  No point named "${id}". Known: ${known.join(", ")}`),
		);
		return commandConsumed({ failed: true });
	}

	// State is either inline JSON or a path to a file holding it. A path is the
	// common case: the thing being judged is usually too big to paste.
	const raw = stateParts.join(" ").trim();
	let state: JudgmentState = { note: "no state supplied" };
	if (raw !== "") {
		try {
			state =
				raw.startsWith("{") || raw.startsWith("[") ? JSON.parse(raw) : JSON.parse(fs.readFileSync(raw, "utf8"));
		} catch (error) {
			await runtime.output(
				theme.fg("error", `  Could not read state: ${error instanceof Error ? error.message : String(error)}`),
			);
			return commandConsumed({ failed: true });
		}
	}

	try {
		const asked = await session.askDecisionPoint(id, state);
		if (!asked) {
			await runtime.output(theme.fg("muted", `  Point "${id}" disappeared before it could run.`));
			return commandConsumed({ failed: true });
		}
		const lines: string[] = [theme.fg("text", theme.bold(`  ${declared.label ?? declared.id}`))];
		lines.push(theme.fg("dim", `  ${asked.result.model} via ${asked.result.api} · risk ${declared.risk}`));
		lines.push("");
		for (const [questionId, answer] of Object.entries(asked.result.answers)) {
			const question = declared.questions[questionId];
			lines.push(`  ${theme.fg("muted", questionId)}  ${theme.fg("dim", question?.instructions ?? "")}`);
			if (answer.type === "choice") {
				for (const [label, p] of Object.entries(answer.probabilities)) {
					const mark = label === answer.choice ? theme.fg("accent", "▸") : " ";
					lines.push(`   ${mark} ${cell(label, 14)} ${theme.fg("dim", probabilityBar(p, 1, 20))} ${p.toFixed(2)}`);
				}
			} else if (answer.type === "score") {
				lines.push(
					`    ${theme.fg("text", String(answer.score))} ${theme.fg("dim", `conf ${answer.confidence.toFixed(2)}`)}`,
				);
			} else if (answer.type === "noul") {
				lines.push(
					`    ${theme.fg("text", answer.noul >= 0.5 ? "yes" : "no")} ${theme.fg("dim", answer.noul.toFixed(2))}`,
				);
			}
			lines.push("");
		}
		await runtime.output(lines.join("\n"));
		return commandConsumed();
	} catch (error) {
		await runtime.output(
			theme.fg("error", `  Decision failed: ${error instanceof Error ? error.message : String(error)}`),
		);
		return commandConsumed({ failed: true });
	}
}

/**
 * Re-ask a recorded decision's questions against a new state.
 *
 * This is the tuning loop the whole feature exists for: a decision went one way
 * and the operator thinks it should have gone another. Replay sends the same
 * questions over a corrected state, so the two answers are comparable — same
 * criteria, same model role, one variable changed.
 */
async function handleReplay(id: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const session = runtime.session;
	const original = session.decisions.get(Number(id));
	if (!original) {
		await runtime.output(theme.fg("muted", `  No decision #${id} in this ledger.`));
		return commandConsumed({ failed: true });
	}
	const declared = (session.userDecisionPoints ?? []).find(point => point.id === original.point);
	if (!declared) {
		await runtime.output(
			theme.fg(
				"muted",
				`  "${original.point}" is a built-in point; only points declared in .ngodeai/decisions can be replayed.`,
			),
		);
		return commandConsumed({ failed: true });
	}
	if (original.state === undefined) {
		await runtime.output(
			theme.fg("muted", `  Decision #${id} did not keep its state, so there is nothing to re-ask.`),
		);
		return commandConsumed({ failed: true });
	}

	try {
		const replayed = await session.askDecisionPoint(declared.id, original.state as JudgmentState);
		if (!replayed) {
			await runtime.output(theme.fg("muted", `  Point "${declared.id}" disappeared before it could run.`));
			return commandConsumed({ failed: true });
		}
		const lines: string[] = [
			theme.fg("text", theme.bold(`  replay ${declared.label ?? declared.id}`)),
			theme.fg("dim", `  original #${id} at ${clock(original.at)} · now ${replayed.result.model}`),
			"",
		];
		for (const [questionId, answer] of Object.entries(replayed.result.answers)) {
			const before = original.answers.find(a => a.question === questionId);
			const now =
				answer.type === "choice"
					? answer.choice
					: answer.type === "score"
						? String(answer.score)
						: answer.type === "noul"
							? answer.noul >= 0.5
								? "yes"
								: "no"
							: "box";
			const previous = before === undefined ? "—" : String(before.value);
			const changed = before !== undefined && previous !== now;
			const mark = changed ? theme.fg("warning", "≠") : theme.fg("dim", "=");
			lines.push(
				`  ${mark} ${cell(questionId, 18)} ${cell(previous, 14)} → ${theme.fg(changed ? "warning" : "text", now)}`,
			);
		}
		await runtime.output(lines.join("\n"));
		return commandConsumed();
	} catch (error) {
		await runtime.output(
			theme.fg("error", `  Replay failed: ${error instanceof Error ? error.message : String(error)}`),
		);
		return commandConsumed({ failed: true });
	}
}

/**
 * The session as one benchmark row.
 *
 * The session is the only task boundary the CLI can observe on its own, so
 * that is what this reports. A caller comparing configurations runs the same
 * task set twice and compares `cost per finished task` between the two rows.
 */
function renderBench(session: AgentSession): string {
	const decisions = session.decisions.list({ limit: 10_000 });
	const totals = session.decisions.totals();
	const report = reportTask({
		task: session.sessionId ?? "session",
		outcome: "running",
		startedAt: decisions.length > 0 ? Math.min(...decisions.map(d => d.at)) : Date.now(),
		decisions,
	});
	const lines: string[] = [];
	lines.push(theme.fg("text", theme.bold("  Decision layer · this session")));
	lines.push(theme.fg("dim", `  ${"─".repeat(64)}`));
	lines.push(`  decisions        ${report.decisions}  (${report.cached} from cache, ${report.gated} gated)`);
	lines.push(`  judge cost       ${cost(report.cost)}`);
	lines.push(
		`  judge latency    ${formatDuration(report.judgeMs)}  (mean ${formatDuration(report.meanJudgeMs)}/decision)`,
	);
	lines.push(`  session wall     ${formatDuration(report.elapsedMs)}`);
	lines.push(
		`  cache hit rate   ${report.decisions === 0 ? "—" : `${Math.round((report.cached / report.decisions) * 100)}%`}`,
	);
	if (report.byPoint.length > 0) {
		lines.push("");
		lines.push(theme.fg("dim", "  by point"));
		for (const point of report.byPoint) {
			lines.push(
				`  ${cell(pointLabel(point.point), 18)} ${String(point.count).padStart(5)} ${cost(point.cost).padStart(12)} ${formatDuration(point.judgeMs).padStart(9)}`,
			);
		}
	}
	lines.push("");
	lines.push(
		theme.fg("dim", "  Cost per finished task needs a finished task set: run the same tasks with and without"),
	);
	lines.push(theme.fg("dim", "  the layer, then compare `summarise()` rows. This row alone is not a saving."));
	return lines.join("\n");
}

async function handleDecisions(command: { args: string }, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const session = runtime.session;
	const raw = command.args.trim();
	// A bare number is a decision id, not a subcommand: `parseSubcommand` would
	// treat it as a verb and report it as unknown.
	const numeric = /^\d+$/.test(raw);
	const parsed = parseSubcommand(command.args);
	const target = numeric ? raw : parsed.rest;

	if (parsed.verb === "new") {
		return handleNew(parsed.rest, runtime);
	}
	if (parsed.verb === "ask") {
		return handleAsk(parsed.rest, runtime);
	}
	if (parsed.verb === "bench") {
		await runtime.output(renderBench(runtime.session));
		return commandConsumed();
	}
	if (parsed.verb === "replay") {
		return handleReplay(parsed.rest.trim(), runtime);
	}
	if (parsed.verb === "status") {
		await runtime.output(renderStatus(session));
		return commandConsumed();
	}
	if (parsed.verb === "points") {
		await runtime.output(renderPoints(session));
		return commandConsumed();
	}
	if (parsed.verb === "conflicts") {
		const conflicts = session.decisions.list({ conflictsOnly: true, limit: LIST_LIMIT });
		await runtime.output(
			conflicts.length === 0
				? theme.fg("muted", "  No decision disagreed with code this session.")
				: renderList(conflicts, session.decisions.totals()),
		);
		return commandConsumed();
	}
	if (parsed.verb === "state") {
		// `/decisions state` shows the layer's configuration; `/decisions <id> state`
		// is covered by the detail view, which prints the state inline.
		await runtime.output(renderStatus(session));
		return commandConsumed();
	}

	if (numeric) {
		const event = session.decisions.get(Number(target));
		await runtime.output(
			event === undefined ? theme.fg("muted", `  No decision #${target} in this ledger.`) : renderDetail(event),
		);
		return commandConsumed();
	}

	if (parsed.verb !== "") {
		await runtime.output(theme.fg("muted", "  Usage: /decisions [status|points|conflicts|<id>]"));
		return commandConsumed();
	}

	await runtime.output(renderList(session.decisions.list({ limit: LIST_LIMIT }), session.decisions.totals()));
	return commandConsumed();
}

export const decisionSlashCommands: SlashCommandSpec[] = [
	{
		name: "decisions",
		icon: "plan",
		description: "Inspect the Artificial Decisions ledger",
		allowArgs: true,
		inlineHint: "[status|points|conflicts|new|ask|replay|bench|<id>]",
		subcommands: [
			{ name: "status", description: "Backend, cache, and confidence thresholds" },
			{ name: "points", description: "Per-point counts, confidence, and cost" },
			{ name: "conflicts", description: "Decisions where code disagreed with the answer" },
			{ name: "new", description: "Create a decision point file", usage: "<name>" },
			{ name: "ask", description: "Run a declared point over a state", usage: "<point> [state-file-or-json]" },
			{ name: "replay", description: "Re-ask a recorded decision against its stored state", usage: "<id>" },
			{ name: "bench", description: "Session cost and latency per decision point" },
		],
		subcommandOptional: true,
		handle: handleDecisions,
		// `/decisions new` with no name opens the authoring wizard, which needs the
		// TUI's editor slot. Every other subcommand stays on the shared handler.
		handleTui: async (command, runtime) => {
			const parsed = parseSubcommand(command.args);
			if (parsed.verb === "new" && parsed.rest.trim() === "") {
				launchDecisionWizard(runtime);
				clearSubmittedText(runtime);
				return commandConsumed();
			}
			// Every other subcommand works off the shared runtime, which the TUI
			// context can build for itself.
			return handleDecisions(command, {
				session: runtime.ctx.session,
				sessionManager: runtime.ctx.sessionManager,
				settings: runtime.ctx.session.settings,
				cwd: runtime.ctx.sessionManager.getCwd(),
				output: text => runtime.ctx.showStatus(text),
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			});
		},
	},
];
