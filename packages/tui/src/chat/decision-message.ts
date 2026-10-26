/**
 * Transcript renderers for Artificial Decisions.
 *
 * A decision earns one of two shapes:
 *
 * - {@link DecisionLine} — one row. Used when the decision changed what the
 *   agent did but needs no explanation: a route, a gate that resolved itself,
 *   a verification that agreed with the answer.
 * - {@link DecisionCard} — an expandable card. Used when a human was involved
 *   or the model was unsure, because then the *distribution* is the useful
 *   part and a single chosen label would hide it.
 *
 * Both render the same event, so the transcript never invents a summary the
 * ledger does not hold. What the user expands is what was recorded.
 *
 * ## Why the bar
 *
 * A probability shown as `0.71` reads as a score out of one and invites the
 * reader to judge the number rather than the shape. A bar shows how the mass
 * is distributed: `██████████████░░░░░░` next to `ask` says "clearly ask, but
 * a quarter of the mass is on allow", which is the fact that decides whether a
 * human should look. The bar is proportional to the top probability against
 * the other options, so a three-way tie looks like a tie.
 */
import type { DecisionAnswerRecord, DecisionEvent } from "@ngodeai/ai";
import { Text } from "../components/text";
import { Container } from "../tui";
import type { Component } from "../tui";
import { theme } from "../theme";
import type { ThemeColor } from "../theme";
import type { TspTone } from "@ngodeai/wire";
import { node, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { replaceTabs, truncateToWidth } from "../render/render-utils";

/** Characters a probability bar is drawn across. */
const BAR_CELLS = 20;

/** ANSI colour per action. */
const SEVERITY: Readonly<Record<DecisionEvent["action"], ThemeColor>> = {
	auto: "success",
	gated: "warning",
	asked: "accent",
	blocked: "error",
	skipped: "muted",
	silent: "muted",
};

/** The same mapping for native terminals, whose tones are a smaller vocabulary. */
const SEVERITY_TONE: Readonly<Record<DecisionEvent["action"], TspTone>> = {
	auto: "success",
	gated: "warning",
	asked: "accent",
	blocked: "error",
	skipped: "muted",
	silent: "muted",
};

/** Short verb per action, chosen so the row reads as a sentence. */
const ACTION_LABEL: Readonly<Record<DecisionEvent["action"], string>> = {
	auto: "allowed",
	gated: "gated",
	asked: "asked",
	blocked: "blocked",
	skipped: "skipped",
	silent: "checked",
};

/** `██████████████░░░░░░`, filled by `value` over `total`. */
export function probabilityBar(value: number, total = 1, cells = BAR_CELLS): string {
	const ratio = total <= 0 ? 0 : Math.max(0, Math.min(1, value / total));
	const filled = Math.round(ratio * cells);
	return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
}

/** The answer a line row names: the first one, which is the one the caller keyed on. */
function leadAnswer(event: DecisionEvent): DecisionAnswerRecord | undefined {
	if (event.decisionKeys?.length) {
		return event.answers.find(answer => event.decisionKeys!.includes(answer.question)) ?? event.answers[0];
	}
	return event.answers[0];
}

/** `ask 0.71` — the chosen value and, when it has one, its probability. */
function answerLabel(answer: DecisionAnswerRecord | undefined): string {
	if (!answer) return "";
	if (answer.type === "noul") {
		return `${Number(answer.value) >= 0.5 ? "yes" : "no"} ${Number(answer.value).toFixed(2)}`;
	}
	if (answer.type === "score") return `${String(answer.value)}`;
	return String(answer.value);
}

/** The probability the chosen answer carried, for the line's confidence column. */
function answerProbability(answer: DecisionAnswerRecord | undefined): number | undefined {
	if (!answer) return undefined;
	if (answer.type === "noul") return Number(answer.value);
	if (answer.probabilities) return answer.probabilities[String(answer.value)] ?? answer.confidence;
	return answer.confidence;
}

/** `38ms` / `1.2s`. */
function formatElapsed(ms: number | undefined): string {
	if (ms === undefined) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/** `$0.00002` — decisions are cheap enough that two decimals would round to zero. */
function formatCost(cost: number | undefined): string {
	if (!cost) return "";
	if (cost < 0.0001) return `$${cost.toFixed(6)}`;
	return `$${cost.toFixed(5)}`;
}

/** A point id as a readable label: `tool_approval` → `tool approval`. */
export function pointLabel(point: string): string {
	return point.replace(/_/g, " ");
}

/**
 * One-row decision summary.
 *
 * Layout: `  ◆ allowed   tool approval · bash          ask 0.71 · 38ms`
 *
 * The row is deliberately terse and dim; a session with dozens of decisions
 * should read as annotations on the conversation, not as a second
 * conversation. Everything the row omits lives in `/decisions`.
 */
export class DecisionLine extends Container {
	readonly #event: DecisionEvent;

	constructor(event: DecisionEvent) {
		super();
		this.#event = event;
	}

	/**
	 * One row, clipped to the width the transcript actually gives us.
	 *
	 * Rendering in `render` rather than the constructor is what makes the row
	 * fit: the width is only known here, and a pre-rendered string would either
	 * wrap into a paragraph or overflow the terminal.
	 */
	override render(width: number): readonly string[] {
		return [truncateToWidth(this.#render(Math.max(1, width)), Math.max(1, width))];
	}

	/** A line has nothing to expand; present so the transcript can toggle every entry uniformly. */
	setExpanded(): void {}

	#render(width: number): string {
		const event = this.#event;
		const color = SEVERITY[event.action];
		const glyph = theme.fg(color, "◆");
		const verb = theme.fg(color, ACTION_LABEL[event.action]);
		const where = theme.fg("dim", pointLabel(event.point));
		const answer = leadAnswer(event);
		const label = answerLabel(answer);
		const probability = answerProbability(answer);
		const parts = [label, probability === undefined ? "" : probability.toFixed(2)].filter(Boolean).join(" ");
		const meta = [theme.fg("dim", parts), theme.fg("dim", formatElapsed(event.elapsedMs))]
			.filter(Boolean)
			.join(theme.fg("dim", " · "));
		const reason = event.reason ? theme.fg("dim", ` · ${event.reason}`) : "";
		const conflict = event.conflict ? theme.fg("error", ` · ⚠ ${event.conflict}`) : "";
		return truncateToWidth(`  ${glyph} ${verb}  ${where}${theme.fg("dim", " · ")}${meta}${reason}${conflict}`, width);
	}

	override describe(): NativeNode {
		const event = this.#event;
		const answer = leadAnswer(event);
		const probability = answerProbability(answer);
		const meta = [answerLabel(answer), probability === undefined ? "" : probability.toFixed(2)]
			.filter(Boolean)
			.join(" ");
		return node("row", { gap: "sm", align: "start", role: "ngodeai.decision.line" }, [
			node("icon", { name: "decision", tone: SEVERITY_TONE[event.action] }, undefined, "icon"),
			text(ACTION_LABEL[event.action], { tone: SEVERITY_TONE[event.action] }),
			text(pointLabel(event.point), { tone: "muted" }),
			text(meta, { tone: "muted" }),
		]);
	}
}

/**
 * An expandable decision card.
 *
 * Collapsed it shows the batch header and the answers that mattered; expanded
 * it adds every question, the full distribution per answer, and the provenance
 * the ledger recorded (model, cost, whether it came from cache).
 *
 * The card is used for a batch — several questions answered in one request —
 * because that is where the shape of the layer shows: one call, many answers,
 * a few of which changed anything. It is also used when a human had to decide,
 * because then the alternatives are the point.
 */
export class DecisionCard extends Container {
	readonly #event: DecisionEvent;
	#expanded: boolean;

	constructor(event: DecisionEvent, expanded = false) {
		super();
		this.#event = event;
		this.#expanded = expanded;
		this.addChild(new Text(this.#render(process.stdout.columns ?? 100), 0, 0));
	}

	/** Re-render with the new expansion state. */
	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.clear();
		this.addChild(new Text(this.#render(process.stdout.columns ?? 100), 0, 0));
	}

	#render(width: number): string {
		const event = this.#event;
		const lines: string[] = [];
		const color = SEVERITY[event.action];
		const answered = event.answers.length;
		const header = [
			theme.fg(color, theme.bold("◆ DECIDE")),
			theme.fg("dim", pointLabel(event.point)),
			theme.fg("dim", `· ${answered} ${answered === 1 ? "question" : "questions"}`),
			event.batchId ? theme.fg("dim", `· batch ${event.batchId}`) : "",
			theme.fg("dim", `· ${formatElapsed(event.elapsedMs)}`),
			formatCost(event.cost) ? theme.fg("dim", `· ${formatCost(event.cost)}`) : "",
			event.cached ? theme.fg("dim", "· cache") : "",
		]
			.filter(Boolean)
			.join(" ");
		lines.push(truncateToWidth(`  ${header}`, width));

		const shown = this.#expanded ? event.answers : event.answers.slice(0, 5);
		for (const answer of shown) {
			lines.push(truncateToWidth(`  ${this.#answerRow(answer, width - 2)}`, width));
		}
		if (!this.#expanded && event.answers.length > shown.length) {
			lines.push(theme.fg("dim", `  … ${event.answers.length - shown.length} more · expand to see every answer`));
		}

		if (event.reason) lines.push(truncateToWidth(`  ${theme.fg("dim", event.reason)}`, width));
		if (event.conflict) {
			lines.push(truncateToWidth(`  ${theme.fg("error", `⚠ ${event.conflict}`)}`, width));
		}
		if (this.#expanded) {
			const provenance = [
				`${event.model} via ${event.api}`,
				event.stateDigest ? `state ${event.stateDigest.slice(0, 12)}` : "",
				event.cachedQuestions !== undefined ? `${event.cachedQuestions} from cache` : "",
			]
				.filter(Boolean)
				.join(" · ");
			lines.push(truncateToWidth(`  ${theme.fg("dim", provenance)}`, width));
			if (event.decisionKeys?.length) {
				lines.push(truncateToWidth(`  ${theme.fg("dim", `decided on: ${event.decisionKeys.join(", ")}`)}`, width));
			}
		}
		lines.push(theme.fg("dim", `  └─ ⏎ expand · /decisions ${event.id ?? ""}`.trimEnd()));
		return lines.join("\n");
	}

	#answerRow(answer: DecisionAnswerRecord, width: number): string {
		const key = theme.fg("muted", replaceTabs(answer.question).slice(0, 22).padEnd(22));
		const label = String(answer.value);
		const probability = answerProbability(answer);
		const confidence = answer.confidence;
		const bar =
			probability === undefined
				? ""
				: theme.fg(
						SEVERITY[this.#event.action],
						probabilityBar(probability, 1, Math.max(8, Math.min(BAR_CELLS, width - 46))),
					);
		const numbers = [
			theme.fg("text", label),
			probability === undefined ? "" : theme.fg("dim", probability.toFixed(2)),
			confidence === undefined || confidence === probability ? "" : theme.fg("dim", `conf ${confidence.toFixed(2)}`),
		]
			.filter(Boolean)
			.join(" ");
		return `${key} ${bar} ${numbers}`;
	}

	override describe(): NativeNode {
		const event = this.#event;
		const children: NativeChild[] = [
			node("icon", { name: "decision", tone: SEVERITY_TONE[event.action] }, undefined, "icon"),
			text("DECIDE", { tone: SEVERITY_TONE[event.action] }),
			text(pointLabel(event.point), { tone: "muted" }),
			text(`${event.answers.length} answers`, { tone: "muted" }),
		];
		const rows: NativeChild[] = [];
		for (const answer of event.answers.slice(0, this.#expanded ? undefined : 5)) {
			const probability = answerProbability(answer);
			rows.push(
				node("row", { gap: "sm", align: "start" }, [
					text(answer.question, { tone: "muted" }),
					text(String(answer.value)),
					probability === undefined ? text("") : text(probability.toFixed(2), { tone: "muted" }),
				]),
			);
		}
		return node("card", { role: "ngodeai.decision.card", title: "Decision" }, [
			node("row", { gap: "sm", align: "start" }, children),
			...rows,
		]);
	}
}

/**
 * Choose a renderer for `event`.
 *
 * `card` is the event's own tier; the caller does not decide here, because the
 * tier was already decided when the decision settled and the transcript must
 * agree with the ledger.
 */
export function createDecisionComponent(
	event: DecisionEvent,
	expanded = false,
): Component & { setExpanded(expanded: boolean): void } {
	return event.tier === "card" ? new DecisionCard(event, expanded) : new DecisionLine(event);
}
