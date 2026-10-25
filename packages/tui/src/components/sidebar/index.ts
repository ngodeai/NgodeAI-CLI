/**
 * Right-hand status sidebar.
 *
 * The transcript is the document; this panel is the at-a-glance state beside it
 * — the plan the agent is working through, how full the context window is, what
 * the session has spent, the branch, the model, and any agents running in the
 * background. Everything here is read-only: a section describes state that
 * already exists elsewhere, so the sidebar can never disagree with the
 * transcript about what happened.
 *
 * The panel is framed like the rest of the brand: square dots at the corners
 * with a hairline rule between them, matching the welcome banner and the setup
 * wizard. One blank column of padding keeps the content off the rules.
 *
 * Layout is a {@link SplitPane} at the composer level; this component only
 * draws the pane, and reports `visible: false` below its minimum width so the
 * host can fall back to rendering the plan inline.
 */
import type { Component } from "../../tui";
import { theme } from "../../theme/theme";
import { truncateToWidth, visibleWidth } from "../../utils";
import { col, node, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";

/** Task state, mirroring the todo tool's vocabulary without importing it. */
export type SidebarTaskStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** One task row in the plan section. */
export interface SidebarTask {
	readonly content: string;
	readonly status: SidebarTaskStatus;
	readonly blocker?: string;
}

/** A named group of tasks, or a flat plan when there is one unnamed phase. */
export interface SidebarTaskPhase {
	readonly name: string;
	readonly tasks: readonly SidebarTask[];
}

/** Context-window occupancy, already resolved to absolute token counts. */
export interface SidebarContext {
	readonly usedTokens: number;
	readonly maxTokens: number;
	/** Percent already computed by the host, so the pane and status line agree. */
	readonly percent?: number;
}

/** Token and cost totals for this session. */
export interface SidebarUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly tokensPerSecond?: number | null;
	/** Session spend in dollars; omitted when the model is subscription-billed. */
	readonly cost?: number;
	/** Wall-clock milliseconds since the session started. */
	readonly elapsedMs?: number;
	/** Cache hit rate as a fraction 0–1; omitted when no cache activity. */
	readonly cacheHitRate?: number;
}

/** Git state for the active repository. */
export interface SidebarGit {
	readonly branch: string;
	readonly added?: number;
	readonly modified?: number;
	readonly deleted?: number;
	readonly ahead?: number;
	readonly behind?: number;
}

/** The model a new turn will use. */
export interface SidebarModel {
	readonly selector: string;
	readonly displayName?: string;
	/** Reasoning effort when the model exposes a ladder. */
	readonly effort?: string;
	/** `true` when the credential is a subscription rather than a metered key. */
	readonly subscription?: boolean;
}

/** One background agent, as the Agent Hub knows it. */
export interface SidebarAgent {
	readonly id: string;
	readonly name: string;
	/** `running` is the only status that gets an active glyph; the rest are history. */
	readonly status: "running" | "idle" | "parked" | "aborted";
	/** Agent type badge (`reviewer`, `explore`, …). */
	readonly kind?: string;
	/** Model selector, truncated to the pane. */
	readonly model?: string;
	/** Wall-clock milliseconds the agent has been alive. */
	readonly durationMs?: number;
	readonly tokens?: number;
	readonly cost?: number;
}

/** Background agents for the sidebar: the roster the Agent Hub shows. */
export interface SidebarAgents {
	readonly running: number;
	readonly total?: number;
	/** The roster itself, newest activity first. Omitted renders the count only. */
	readonly list?: readonly SidebarAgent[];
}

/** Everything the sidebar renders, assembled by the host each frame it changes. */
export interface SidebarState {
	readonly tasks?: readonly SidebarTaskPhase[];
	readonly context?: SidebarContext;
	readonly usage?: SidebarUsage;
	readonly git?: SidebarGit;
	readonly model?: SidebarModel;
	readonly agents?: SidebarAgents;
}

/** Narrowest pane worth drawing; below this the sidebar yields to the transcript. */
export const SIDEBAR_MIN_WIDTH = 24;
/**
 * Widest the pane grows. Task labels wrap to two or three lines at 30 columns,
 * so the ceiling is generous enough for a wide terminal to show a whole task
 * per line without the transcript losing its majority.
 */
export const SIDEBAR_MAX_WIDTH = 48;
/** Terminal width below which the sidebar collapses entirely. */
export const SIDEBAR_SPLIT_AT = 100;

/** Frame glyphs, matching the welcome banner and setup wizard. */
const FRAME = {
	topLeft: "▪",
	topRight: "▪",
	bottomLeft: "▪",
	bottomRight: "▪",
	horizontal: "─",
	vertical: "│",
} as const;

/** Columns of padding between the frame and the content. */
const PAD_X = 1;

/**
 * Clamp a requested width into the sidebar's usable range.
 *
 * The host may ask for a width from settings; this keeps a too-small request
 * from producing an unreadable pane and a too-large one from crowding out the
 * transcript.
 */
export function clampSidebarWidth(requested: number): number {
	return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(requested)));
}

/** Section title: dim, uppercase, with one blank row above except for the first. */
function heading(label: string, first: boolean): string[] {
	const rows = first ? [] : [""];
	rows.push(theme.bold(theme.fg("dim", label.toUpperCase())));
	return rows;
}

/** Task glyph for a status, in the theme's checkbox vocabulary. */
function taskGlyph(status: SidebarTaskStatus): string {
	switch (status) {
		case "completed":
			return theme.fg("success", theme.checkbox.checked);
		case "abandoned":
			return theme.fg("error", theme.checkbox.unchecked);
		case "blocked":
			return theme.fg("warning", "!");
		case "in_progress":
			return theme.fg("accent", "▸");
		default:
			return theme.fg("dim", theme.checkbox.unchecked);
	}
}

/**
 * Wrap styled text to `width` columns on word boundaries.
 *
 * `truncateToWidth` alone would cut a task mid-word; a sidebar whose rows are
 * one word short of readable is worse than one extra row. The style is
 * re-applied per row because the source string carried a single SGR pair and
 * splitting it would leave later rows unstyled.
 */
function wrapStyled(styled: string, width: number): string[] {
	const plain = stripAnsi(styled);
	if (visibleWidth(plain) <= width) return [styled];
	const words = plain.split(/(\s+)/);
	const rows: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length === 0) {
			// A single word wider than the pane has no space to break on. Split
			// it by cells rather than letting it overflow — an unbroken identifier
			// like an agent name is exactly the case that hits this.
			if (visibleWidth(word) > width) {
				let rest = word;
				while (visibleWidth(rest) > width) {
					let take = rest.length;
					while (take > 1 && visibleWidth(rest.slice(0, take)) > width) take--;
					rows.push(rest.slice(0, take));
					rest = rest.slice(take);
				}
				current = rest;
				continue;
			}
			current = word;
			continue;
		}
		if (visibleWidth(current + word) <= width) {
			current += word;
		} else {
			rows.push(current.trimEnd());
			current = word.trimStart();
		}
	}
	if (current.length > 0) rows.push(current.trimEnd());
	const open = styled.match(/^(?:\x1b\[[0-9;]*m)+/)?.[0] ?? "";
	const close = styled.match(/(?:\x1b\[[0-9;]*m)+$/)?.[0] ?? "";
	return rows.map(row => (open && close ? `${open}${row}${close}` : row));
}

/** Drop SGR sequences for measurement. */
function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * One task row wrapped to `width`, with continuation rows indented under the
 * label so a long task never reads as two separate items.
 */
function taskRows(task: SidebarTask, width: number): string[] {
	const glyph = taskGlyph(task.status);
	const label = task.status === "blocked" && task.blocker ? `${task.content} — ${task.blocker}` : task.content;
	const color =
		task.status === "completed"
			? "dim"
			: task.status === "abandoned"
				? "error"
				: task.status === "blocked"
					? "warning"
					: task.status === "in_progress"
						? "accent"
						: "muted";
	// Every row spends `indent` cells on the glyph (or matching spaces), so the
	// text wraps to the remainder. Wrapping to the full width first produced
	// rows two cells too wide.
	const indent = visibleWidth(glyph) + 1;
	const rows = wrapStyled(theme.fg(color, label), Math.max(1, width - indent));
	return rows.map((row, index) => (index === 0 ? `${glyph} ${row}` : `${" ".repeat(indent)}${row}`));
}

/** Rows for the plan section: phases, each with its tasks. */
function taskSection(phases: readonly SidebarTaskPhase[], width: number): string[] {
	const rows: string[] = [];
	const multiPhase = phases.length > 1 || (phases[0]?.name ?? "").length > 0;
	for (const [index, phase] of phases.entries()) {
		if (multiPhase) {
			if (index > 0) rows.push("");
			const done = phase.tasks.filter(task => task.status === "completed").length;
			rows.push(
				truncateToWidth(
					`${theme.fg("muted", phase.name || `Phase ${index + 1}`)} ${theme.fg("dim", `${done}/${phase.tasks.length}`)}`,
					width,
				),
			);
		}
		for (const task of phase.tasks) rows.push(...taskRows(task, width));
	}
	return rows;
}

/** `▓▓▓░░ 42%` gauge plus absolute token counts. */
function contextRows(context: SidebarContext, width: number): string[] {
	const ratio =
		context.percent !== undefined
			? Math.max(0, Math.min(1, context.percent / 100))
			: context.maxTokens > 0
				? Math.max(0, Math.min(1, context.usedTokens / context.maxTokens))
				: 0;
	const percent = Math.round(ratio * 100);
	const tone = ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "accent";
	const suffix = ` ${percent}%`;
	const barWidth = Math.max(4, width - visibleWidth(suffix));
	const filled = Math.round(ratio * barWidth);
	const gauge =
		theme.fg(tone, "▓".repeat(filled)) +
		theme.fg("dim", "░".repeat(Math.max(0, barWidth - filled))) +
		theme.fg(tone, suffix);
	const counts = `${formatTokens(context.usedTokens)} / ${formatTokens(context.maxTokens)}`;
	return [gauge, truncateToWidth(theme.fg("dim", counts), width)];
}

/** Compact token count: `1.2k`, `200k`, `1.0M`. */
function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) return "?";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(Math.round(tokens));
}

/** `1h 02m`, `12m 34s`, `45s`. */
function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/**
 * `$0.42` at or above a cent, `$0.0030` below it.
 *
 * A subagent can cost a fraction of a cent; collapsing every such figure to
 * `<$0.01` makes a cheap agent and a nearly-free one look identical.
 */
function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0";
	if (cost < 0.01) {
		const text = cost.toFixed(4);
		return `$${text.replace(/0+$/, "").replace(/\.$/, "")}`;
	}
	return `$${cost.toFixed(2)}`;
}

/**
 * Token flow, throughput, spend, elapsed time, and cache hit rate.
 *
 * Facts are paired onto one row each so the section stays short: the sidebar is
 * an overview, and a five-row block for five numbers crowds out the plan.
 */
function usageRows(usage: SidebarUsage, width: number): string[] {
	const rows: string[] = [];
	const tokens = `${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out`;
	rows.push(truncateToWidth(theme.fg("muted", tokens), width));

	const second: string[] = [];
	if (usage.tokensPerSecond != null && usage.tokensPerSecond > 0) {
		second.push(theme.fg("accent", `${Math.round(usage.tokensPerSecond)} t/s`));
	}
	if (usage.cost !== undefined) second.push(theme.fg("statusLineCost", formatCost(usage.cost)));
	if (usage.elapsedMs !== undefined) second.push(theme.fg("dim", formatDuration(usage.elapsedMs)));
	if (second.length > 0) rows.push(truncateToWidth(second.join(theme.fg("dim", " · ")), width));

	if (usage.cacheHitRate !== undefined) {
		const pct = Math.round(Math.max(0, Math.min(1, usage.cacheHitRate)) * 100);
		rows.push(truncateToWidth(theme.fg("dim", `cache ${pct}%`), width));
	}
	return rows;
}

/** Branch plus a short diff summary and ahead/behind counts. */
function gitRows(git: SidebarGit, width: number): string[] {
	const rows = [truncateToWidth(theme.fg("accent", git.branch), width)];
	const parts: string[] = [];
	if (git.added) parts.push(theme.fg("success", `+${git.added}`));
	if (git.modified) parts.push(theme.fg("warning", `~${git.modified}`));
	if (git.deleted) parts.push(theme.fg("error", `-${git.deleted}`));
	if (git.ahead) parts.push(theme.fg("dim", `↑${git.ahead}`));
	if (git.behind) parts.push(theme.fg("dim", `↓${git.behind}`));
	if (parts.length > 0) rows.push(truncateToWidth(parts.join(" "), width));
	return rows;
}

/** Model display name with effort and billing mode beneath. */
function modelRows(model: SidebarModel, width: number): string[] {
	const name = model.displayName ?? model.selector;
	const rows = [truncateToWidth(theme.fg("accent", name), width)];
	const meta: string[] = [];
	if (model.effort) meta.push(theme.fg("dim", model.effort));
	if (model.subscription) meta.push(theme.fg("success", "subscription"));
	if (meta.length > 0) rows.push(truncateToWidth(meta.join(theme.fg("dim", " · ")), width));
	if (model.displayName && model.displayName !== model.selector) {
		rows.push(truncateToWidth(theme.fg("dim", model.selector), width));
	}
	return rows;
}

/**
 * The agent roster: one row per agent with its state glyph, then indented
 * detail rows for the model and the cost/time it has burned.
 *
 * A count alone ("1 running") tells you nothing you can act on. The hub already
 * tracks name, status, model, duration, tokens and cost per agent, so the
 * sidebar mirrors that instead of hiding it behind a modal.
 */
function agentRows(agents: SidebarAgents, width: number): string[] {
	const rows: string[] = [];

	// An empty roster still shows the section. Hiding it made the pane's height
	// change every time the last agent finished, and left the user wondering
	// whether agents were supported at all.
	if (agents.running <= 0 && (agents.list?.length ?? 0) === 0) {
		return [truncateToWidth(theme.fg("dim", "No agents running"), width)];
	}

	// Count line: `1 running · 2 total` when there is history behind it.
	if (agents.running > 0) {
		const label =
			agents.total !== undefined && agents.total !== agents.running
				? `${agents.running} running · ${agents.total} total`
				: `${agents.running} running`;
		rows.push(truncateToWidth(theme.fg("muted", label), width));
	}

	for (const agent of agents.list ?? []) {
		const glyph =
			agent.status === "running"
				? theme.fg("accent", "▸")
				: agent.status === "aborted"
					? theme.fg("error", "✗")
					: agent.status === "parked"
						? theme.fg("warning", "⏸")
						: theme.fg("success", "✓");
		const nameColor = agent.status === "running" ? "accent" : "muted";
		const kind = agent.kind ? theme.fg("dim", ` ${agent.kind}`) : "";
		// Name wraps rather than truncates: an agent's identity is the one thing
		// worth reading in full, and the pane is narrow by design.
		const indent = visibleWidth(glyph) + 1;
		const nameRows = wrapStyled(theme.fg(nameColor, agent.name) + kind, Math.max(1, width - indent));
		rows.push(`${glyph} ${nameRows[0] ?? ""}`);
		for (const extra of nameRows.slice(1)) rows.push(`${" ".repeat(indent)}${extra}`);

		// Detail rows: model, then the cost/time pair when both exist.
		const detailIndent = " ".repeat(indent);
		if (agent.model) {
			rows.push(truncateToWidth(detailIndent + theme.fg("dim", agent.model), width));
		}
		const facts: string[] = [];
		if (agent.cost !== undefined && agent.cost > 0) facts.push(theme.fg("statusLineCost", formatCost(agent.cost)));
		if (agent.durationMs !== undefined) facts.push(theme.fg("dim", formatDuration(agent.durationMs)));
		if (agent.tokens !== undefined && agent.tokens > 0)
			facts.push(theme.fg("dim", `${formatTokens(agent.tokens)} tok`));
		if (facts.length > 0) {
			rows.push(truncateToWidth(detailIndent + facts.join(theme.fg("dim", " · ")), width));
		}
	}
	return rows;
}

/** Map the sidebar's task vocabulary onto the checklist node's. */
function sidebarToChecklistStatus(status: SidebarTaskStatus): "pending" | "active" | "done" | "dropped" | "blocked" {
	switch (status) {
		case "completed":
			return "done";
		case "abandoned":
			return "dropped";
		case "blocked":
			return "blocked";
		case "in_progress":
			return "active";
		default:
			return "pending";
	}
}

/**
 * The sidebar itself. Renders sections top to bottom in a fixed order and
 * reports whether it fits, so the host can decide to collapse it.
 */
export class StatusSidebar implements Component {
	#state: SidebarState = {};
	#width = SIDEBAR_MIN_WIDTH;
	#visible = true;

	/** Replace the rendered state. An unchanged state keeps the cached rows. */
	setState(state: SidebarState): void {
		this.#state = state;
	}

	/** Width the pane was last rendered at; the host uses it for split geometry. */
	get width(): number {
		return this.#width;
	}

	/** False when the last render collapsed (terminal too narrow). */
	get visible(): boolean {
		return this.#visible;
	}

	/**
	 * Rows the pane should occupy. The host sets this to the viewport height so
	 * the frame's bottom rule lands on the last row instead of mid-screen.
	 */
	setHeight(height: number | undefined): void {
		this.#height = height === undefined ? undefined : Math.max(0, Math.round(height));
	}

	#height: number | undefined;

	render(width: number): readonly string[] {
		this.#width = Math.max(0, width);
		this.#visible = this.#width >= SIDEBAR_MIN_WIDTH;
		if (!this.#visible) return [];

		const innerWidth = Math.max(1, this.#width - 2);
		const contentWidth = Math.max(1, innerWidth - PAD_X * 2);
		const rows: string[] = [];
		const { tasks, context, usage, git, model, agents } = this.#state;

		// The plan is unbounded — a five-phase run produces thirty rows — while
		// everything below it is a fixed handful. Left alone, a long plan pushed
		// CONTEXT/SESSION/GIT/MODEL/AGENTS off the bottom of the pane and the user
		// lost the status they opened the sidebar for. Reserve the space the lower
		// sections need, then give the plan what is left.
		const lowerBudget =
			(context && context.maxTokens > 0 ? heading("Context", false).length + 2 : 0) +
			(usage ? heading("Session", false).length + 3 : 0) +
			(git ? heading("Git", false).length + 2 : 0) +
			(model ? heading("Model", false).length + 2 : 0) +
			(agents ? heading("Agents", false).length + agentRows(agents, contentWidth).length : 0);
		const interior = this.#height === undefined ? undefined : Math.max(0, this.#height - 2);
		// The plan yields first: every lower section is a fixed handful of rows and
		// is what the sidebar exists to surface, while the plan can always be read
		// in the transcript. Only when even a one-row plan will not fit do the
		// lower sections get squeezed, and MIN_TASK_ROWS is the floor there.
		const taskBudget =
			interior === undefined ? undefined : Math.max(1, interior - lowerBudget - heading("Tasks", true).length);

		if (tasks && tasks.length > 0) {
			rows.push(...heading("Tasks", true));
			const taskRowsAll = taskSection(tasks, contentWidth);
			if (taskBudget !== undefined && taskRowsAll.length > taskBudget) {
				// Trim from the bottom and say so, rather than silently dropping the
				// tail: a plan that looks complete but is not is worse than one that
				// admits it was cut.
				const shown = taskRowsAll.slice(0, Math.max(0, taskBudget - 1));
				const hidden = taskRowsAll.length - shown.length;
				rows.push(...shown);
				rows.push(truncateToWidth(theme.fg("dim", `… ${hidden} more`), contentWidth));
			} else {
				rows.push(...taskRowsAll);
			}
		}
		if (context && context.maxTokens > 0) {
			rows.push(...heading("Context", rows.length === 0));
			rows.push(...contextRows(context, contentWidth));
		}
		if (usage) {
			rows.push(...heading("Session", rows.length === 0));
			rows.push(...usageRows(usage, contentWidth));
		}
		if (git) {
			rows.push(...heading("Git", rows.length === 0));
			rows.push(...gitRows(git, contentWidth));
		}
		if (model) {
			rows.push(...heading("Model", rows.length === 0));
			rows.push(...modelRows(model, contentWidth));
		}
		if (agents) {
			rows.push(...heading("Agents", rows.length === 0));
			rows.push(...agentRows(agents, contentWidth));
		}

		// An empty pane still draws its frame: the sidebar is a persistent part of
		// the layout, and a frame that appears and disappears as sections come and
		// go reads as flicker.
		return frame(rows, this.#width, this.#height);
	}

	/** Native mirror of {@link render}: the same sections as TSP nodes. */
	describe(): NativeNode {
		const { tasks, context, usage, git, model, agents } = this.#state;
		const sections: NativeNode[] = [];

		if (tasks && tasks.length > 0) {
			const phases = tasks.map((phase, phaseIndex) => ({
				id: `phase-${phaseIndex}`,
				title: [span(phase.name, "muted")],
				items: phase.tasks.map((task, taskIndex) => ({
					id: `${phaseIndex}.${taskIndex}`,
					text: [span(task.content, "muted")],
					status: sidebarToChecklistStatus(task.status),
					...(task.blocker ? { note: [span(task.blocker, "warning")] } : {}),
				})),
			}));
			sections.push(text([span("TASKS", "dim strong")]));
			sections.push(node("checklist", { mode: "full", phases, role: "ngodeai.sidebar.tasks" }));
		}

		if (context && context.maxTokens > 0) {
			const ratio =
				context.percent !== undefined
					? Math.max(0, Math.min(1, context.percent / 100))
					: Math.max(0, Math.min(1, context.usedTokens / context.maxTokens));
			sections.push(text([span("CONTEXT", "dim strong")]));
			sections.push(
				node("meter", {
					value: ratio,
					style: "bar",
					thresholds: { warn: 0.7, bad: 0.9 },
					label: [span(`${Math.round(ratio * 100)}%`, "muted")],
					role: "ngodeai.sidebar.context",
				}),
			);
		}

		if (usage) {
			sections.push(text([span("SESSION", "dim strong")]));
			sections.push(
				text([span(`${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out`, "muted")], {
					wrap: "none",
				}),
			);
		}

		if (git) {
			sections.push(text([span("GIT", "dim strong")]));
			sections.push(text([span(git.branch, "accent")], { wrap: "none" }));
		}

		if (model) {
			sections.push(text([span("MODEL", "dim strong")]));
			sections.push(text([span(model.displayName ?? model.selector, "accent")], { wrap: "none" }));
		}

		if (agents) {
			sections.push(text([span("AGENTS", "dim strong")]));
			const label = agents.running > 0 ? `${agents.running} running` : "No agents running";
			sections.push(text([span(label, agents.running > 0 ? "muted" : "dim")], { wrap: "none" }));
		}

		return col(sections, { gap: "sm", role: "ngodeai.sidebar" });
	}
}

/**
 * Wrap `rows` in the square-dot card.
 *
 * The top and bottom rules span the full pane width with a dot at each end;
 * content rows get a vertical rule on both sides and one column of padding.
 * Every row is padded to exactly `width` so a row shorter than the frame never
 * leaves the rule floating mid-line.
 */
function frame(rows: readonly string[], width: number, height?: number): string[] {
	const innerWidth = Math.max(1, width - 2);
	const rule = theme.fg("border", FRAME.horizontal.repeat(innerWidth));
	const edge = (left: string, right: string): string => theme.fg("accent", left) + rule + theme.fg("accent", right);

	// Grow the body to fill the requested height so the closing rule lands on
	// the pane's last row. Without this the bottom rule sat right after the last
	// section and the rest of the pane was a borderless void.
	const body = [...rows];
	if (height !== undefined) {
		const interior = Math.max(0, height - 2);
		while (body.length < interior) body.push("");
		body.length = Math.min(body.length, interior);
	}

	const out: string[] = [edge(FRAME.topLeft, FRAME.topRight)];
	for (const row of body) {
		const body = row;
		const bodyWidth = visibleWidth(body);
		// Padding on BOTH sides: innerWidth is the space between the two rules,
		// so it has to cover the left pad, the content, and the right pad.
		const right = Math.max(0, innerWidth - PAD_X - bodyWidth - PAD_X);
		out.push(
			theme.fg("border", FRAME.vertical) +
				" ".repeat(PAD_X) +
				body +
				" ".repeat(right) +
				" ".repeat(PAD_X) +
				theme.fg("border", FRAME.vertical),
		);
	}
	out.push(edge(FRAME.bottomLeft, FRAME.bottomRight));
	return out;
}
