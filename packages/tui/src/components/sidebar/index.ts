/**
 * Right-hand status sidebar.
 *
 * The transcript is the document; this panel is the at-a-glance state beside it
 * — the plan the agent is working through, how full the context window is, the
 * branch, and the model in play. Everything here is read-only: a section
 * describes state that already exists elsewhere, so the sidebar can never
 * disagree with the transcript about what happened.
 *
 * Layout is a {@link SplitPane} so the same component works at any width: wide
 * terminals get two panes, narrow ones collapse to the transcript alone and the
 * sidebar reports `visible: false` so the host can fall back to rendering the
 * plan inline.
 */
import type { Component } from "../../tui";
import { Container } from "../../tui";
import { Text } from "../text";
import { Spacer } from "../spacer";
import { theme } from "../../theme/theme";
import { visibleWidth, truncateToWidth } from "../../utils";
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
}

/** Everything the sidebar renders, assembled by the host each frame it changes. */
export interface SidebarState {
	readonly tasks?: readonly SidebarTaskPhase[];
	readonly context?: SidebarContext;
	readonly git?: SidebarGit;
	readonly model?: SidebarModel;
}

/** Narrowest pane worth drawing; below this the sidebar yields to the transcript. */
export const SIDEBAR_MIN_WIDTH = 22;
/** Widest the pane grows, so a very wide terminal stays transcript-dominant. */
export const SIDEBAR_MAX_WIDTH = 36;
/** Terminal width below which the sidebar collapses entirely. */
export const SIDEBAR_SPLIT_AT = 100;
/** Column the divider occupies between the panes. */
const DIVIDER = "│";

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

/** Section title: dim, uppercase, one blank row above except for the first. */
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
	const text = theme.fg(color, label);
	// Every row spends `indent` cells on the glyph (or the matching spaces), so
	// the text itself wraps to the remainder. Wrapping to the full width first
	// produced rows two cells too wide.
	const indent = visibleWidth(glyph) + 1;
	const rows = wrapPrefixed(text, Math.max(1, width - indent));
	return rows.map((row, index) => (index === 0 ? `${glyph} ${row}` : `${" ".repeat(indent)}${row}`));
}

/**
 * Wrap styled text to `width` columns, breaking on spaces.
 *
 * `truncateToWidth` alone would cut a task mid-word; a sidebar whose rows are
 * one word short of readable is worse than one extra row. ANSI sequences are
 * preserved because the wrap works on the already-styled string and the theme's
 * reset is re-applied per row.
 */
function wrapPrefixed(styled: string, width: number): string[] {
	const plain = stripAnsi(styled);
	if (visibleWidth(plain) <= width) return [styled];
	// The styled string and the plain string have different lengths, so wrap on
	// the plain text and re-derive each row's slice from the original by walking
	// both in step. Words are the unit: a row always ends on a space boundary.
	const words = plain.split(/(\s+)/);
	const rows: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length === 0) {
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
	// Re-apply the style to every row: the source string carried one SGR pair,
	// and splitting it would leave later rows unstyled.
	const open = styled.match(/^(?:\x1b\[[0-9;]*m)+/)?.[0] ?? "";
	const close = styled.match(/(?:\x1b\[[0-9;]*m)+$/)?.[0] ?? "";
	return rows.map(row => (open && close ? `${open}${row}${close}` : row));
}

/** Drop SGR sequences for measurement. */
function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/** `▓▓▓░░ 42%` style gauge plus absolute token counts. */
function contextRows(context: SidebarContext, width: number): string[] {
	const ratio = context.maxTokens > 0 ? Math.max(0, Math.min(1, context.usedTokens / context.maxTokens)) : 0;
	const percent = Math.round(ratio * 100);
	const label = `${formatTokens(context.usedTokens)} / ${formatTokens(context.maxTokens)}`;
	const barWidth = Math.max(4, width - visibleWidth(label) - 1);
	const filled = Math.round(ratio * barWidth);
	const bar =
		theme.fg(ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "accent", "▓".repeat(filled)) +
		theme.fg("dim", "░".repeat(Math.max(0, barWidth - filled)));
	const gauge = `${bar} ${theme.fg(ratio >= 0.9 ? "error" : "muted", `${percent}%`)}`;
	// Counts go under the gauge when both cannot share a row.
	if (visibleWidth(label) + 1 + barWidth > width) return [gauge, theme.fg("dim", label)];
	return [gauge, theme.fg("dim", label)];
}

/** Compact token count: `1.2k`, `200k`, `1.0M`. */
function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) return "?";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(Math.round(tokens));
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

/** Model display name (or selector) with effort when present. */
function modelRows(model: SidebarModel, width: number): string[] {
	const name = model.displayName ?? model.selector;
	const rows = [truncateToWidth(theme.fg("accent", name), width)];
	if (model.effort) rows.push(theme.fg("dim", model.effort));
	if (model.displayName && model.displayName !== model.selector) {
		rows.push(truncateToWidth(theme.fg("dim", model.selector), width));
	}
	return rows;
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

	render(width: number): readonly string[] {
		this.#width = Math.max(0, width);
		this.#visible = this.#width >= SIDEBAR_MIN_WIDTH;
		if (!this.#visible) return [];

		const contentWidth = Math.max(1, this.#width);
		const rows: string[] = [];
		const { tasks, context, git, model } = this.#state;

		if (tasks && tasks.length > 0) {
			rows.push(...heading("Tasks", true));
			rows.push(...taskSection(tasks, contentWidth));
		}
		if (context && context.maxTokens > 0) {
			rows.push(...heading("Context", rows.length === 0));
			rows.push(...contextRows(context, contentWidth));
		}
		if (git) {
			rows.push(...heading("Git", rows.length === 0));
			rows.push(...gitRows(git, contentWidth));
		}
		if (model) {
			rows.push(...heading("Model", rows.length === 0));
			rows.push(...modelRows(model, contentWidth));
		}
		return rows;
	}

	/** Native mirror of {@link render}: the same sections as TSP nodes. */
	describe(): NativeNode {
		const { tasks, context, git, model } = this.#state;
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
			const ratio = Math.max(0, Math.min(1, context.usedTokens / context.maxTokens));
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

		if (git) {
			sections.push(text([span("GIT", "dim strong")]));
			sections.push(text([span(git.branch, "accent")], { wrap: "none" }));
		}

		if (model) {
			sections.push(text([span("MODEL", "dim strong")]));
			sections.push(text([span(model.displayName ?? model.selector, "accent")], { wrap: "none" }));
		}

		return col(sections, { gap: "sm", role: "ngodeai.sidebar" });
	}
}

/**
 * Divider drawn between the transcript and the sidebar. Returns no rows when
 * the sidebar is collapsed so the transcript keeps the full width.
 */
export function sidebarDivider(visible: boolean): (width: number) => readonly string[] {
	if (!visible) return () => [];
	return (width: number) => {
		const rows: string[] = [];
		for (let index = 0; index < Math.max(1, width); index++) rows.push(theme.fg("borderMuted", DIVIDER));
		return rows;
	};
}

export { Container, Spacer, Text };
