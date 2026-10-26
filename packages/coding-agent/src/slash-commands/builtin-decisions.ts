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
import type { DecisionEvent } from "@ngodeai/ai";
import type { DecisionTotals } from "../judgment/ledger";
import { pointLabel, probabilityBar } from "@ngodeai/tui/chat/decision-message";
import { theme } from "@ngodeai/tui/theme";
import type { AgentSession } from "../session/agent-session";
import { commandConsumed, parseSubcommand } from "./helpers/parse";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

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
	lines.push(
		theme.fg("dim", "  /decisions <id> detail · status thresholds · points summary · conflicts disagreements"),
	);
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
	const threshold = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : "never");
	const lines: string[] = [];
	lines.push(theme.fg("text", theme.bold("  Artificial Decisions")));
	lines.push(theme.fg("dim", `  ${"─".repeat(60)}`));
	lines.push(`  recording   ${layer.enabled ? theme.fg("success", "on") : theme.fg("muted", "off")}`);
	lines.push(`  ledger      ${layer.ledger ? theme.fg("success", "open") : theme.fg("muted", "unavailable")}`);
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
	if (points.length === 0) return theme.fg("muted", "  No decisions recorded yet.");
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
	return lines.join("\n");
}

async function handleDecisions(command: { args: string }, runtime: SlashCommandRuntime): Promise<{ consumed: true }> {
	const session = runtime.session;
	const raw = command.args.trim();
	// A bare number is a decision id, not a subcommand: `parseSubcommand` would
	// treat it as a verb and report it as unknown.
	const numeric = /^\d+$/.test(raw);
	const parsed = parseSubcommand(command.args);
	const target = numeric ? raw : parsed.rest;

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
		inlineHint: "[status|points|conflicts|<id>]",
		subcommands: [
			{ name: "status", description: "Backend, cache, and confidence thresholds" },
			{ name: "points", description: "Per-point counts, confidence, and cost" },
			{ name: "conflicts", description: "Decisions where code disagreed with the answer" },
		],
		subcommandOptional: true,
		handle: handleDecisions,
	},
];
