/**
 * `/decisions new` wizard: author a decision point without leaving the terminal.
 *
 * A point file is four fields and a question, but writing it by hand means
 * getting the criteria *shape* right — an array is a score, a `true`/`false`
 * map is a yes/no, any other label map is a choice — and a mistake there
 * silently changes what the question means. The wizard asks for the intent and
 * writes the shape.
 *
 * Five steps:
 *
 * 1. **Name** — the file stem, validated as an id.
 * 2. **Kind** — one of the three primitives, described by what it answers.
 * 3. **Question** — the instruction the judge reads.
 * 4. **Options or levels** — the labels, one per line; skipped for a yes/no.
 * 5. **Risk** — what the answer authorizes, which picks the confidence floor.
 *
 * The file is written on the last step and the wizard reports the path, so the
 * next move (edit it, run `/decisions ask`) is in the same breath. Nothing is
 * written on cancel.
 */
import { Container } from "../tui";
import type { Component } from "../tui";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { TextFormField } from "../components/form";
import { SelectList } from "../components/select-list";
import { getSelectListTheme, theme } from "../theme/theme";
import { formatKeyHint } from "../app-keybindings";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";

/** The primitive a point uses, as the wizard names it. */
type PointKind = "yesno" | "score" | "choice";

/** Risk class the point authorizes. */
type PointRisk = "read" | "write" | "irreversible";

/** What the wizard produces. */
export interface DecisionPointDraft {
	/** File stem; already validated as an id. */
	id: string;
	kind: PointKind;
	instruction: string;
	/** Labels for a choice, levels (lowest first) for a score; empty for a yes/no. */
	labels: string[];
	risk: PointRisk;
}

/** Callbacks the host supplies. */
export interface DecisionPointWizardOptions {
	/** Write the draft. Rejects with a message the wizard shows in place. */
	onCreate: (draft: DecisionPointDraft) => Promise<string | undefined> | string | undefined;
	/** Leave the wizard without writing anything. */
	onCancel: () => void;
	/** Repaint after a step transition. */
	requestRender: () => void;
	/** Existing point ids, so a duplicate name is caught before the write. */
	existing?: readonly string[];
}

const KINDS: { value: PointKind; label: string; description: string }[] = [
	{
		value: "yesno",
		label: "Yes or no",
		description: "One condition holds or it does not, with a calibrated probability.",
	},
	{
		value: "score",
		label: "Score on a scale",
		description: "How much of something: coverage, severity, readiness. Levels run lowest first.",
	},
	{
		value: "choice",
		label: "Pick one option",
		description: "One of a fixed set of outcomes, with a probability per option.",
	},
];

const RISKS: { value: PointRisk; label: string; description: string }[] = [
	{ value: "read", label: "Read", description: "Observes or routes; nothing is modified." },
	{ value: "write", label: "Write", description: "Changes files or state, and can be undone." },
	{
		value: "irreversible",
		label: "Irreversible",
		description: "Cannot be undone. Never auto-approves, whatever the confidence.",
	},
];

/** Field theme matching the rest of the TUI's forms. */
const fieldTheme = {
	label: (text: string) => theme.fg("accent", theme.bold(text)),
	description: (text: string) => theme.fg("muted", text),
	error: (text: string) => theme.fg("error", text),
	hint: (text: string) => theme.fg("dim", text),
};

/** `1/5` in the heading, so the user knows how much is left. */
function heading(title: string, step: number, total: number): Component {
	return new Text(`${theme.fg("accent", theme.bold(title))} ${theme.fg("dim", `${step}/${total}`)}`, 0, 0);
}

export class DecisionPointWizard extends Container {
	readonly #options: DecisionPointWizardOptions;
	readonly #total = 5;
	#step = 0;
	#id = "";
	#kind: PointKind = "yesno";
	#instruction = "";
	#labels: string[] = [];
	#risk: PointRisk = "read";
	#error: string | undefined;
	#list: SelectList | undefined;
	#listIndex = 0;
	/** Items of the active list step, so keyboard movement can clamp without reaching into SelectList internals. */
	#listItems: readonly { value: string }[] = [];
	/** Focus target the host should give input to after a transition. */
	#focus: Component = this;

	constructor(options: DecisionPointWizardOptions) {
		super();
		this.#options = options;
		this.#render();
	}

	/** The component that should hold focus right now. */
	get focusTarget(): Component {
		return this.#focus;
	}

	override invalidate(): void {
		super.invalidate();
		this.clear();
		this.#render();
	}

	/** Route input to the active step. */
	handleInput(data: string): void {
		if (matchesAppInterrupt(data)) {
			this.#options.onCancel();
			return;
		}
		if (this.#list) {
			if (matchesSelectUp(data)) {
				this.#listIndex = Math.max(0, this.#listIndex - 1);
				this.#list.setSelectedIndex(this.#listIndex);
				this.#options.requestRender();
				return;
			}
			if (matchesSelectDown(data)) {
				this.#listIndex = Math.min(this.#listItems.length - 1, this.#listIndex + 1);
				this.#list.setSelectedIndex(this.#listIndex);
				this.#options.requestRender();
				return;
			}
		}
		// Every focus target is a form field or a select list, both of which accept
		// raw key data; the guard keeps the call honest without asserting a shape.
		const focused: Component = this.#focus;
		if ("handleInput" in focused && typeof focused.handleInput === "function") {
			focused.handleInput(data);
		}
	}

	#render(): void {
		this.clear();
		this.#list = undefined;
		this.#listItems = [];
		this.addChild(new Spacer(1));
		switch (this.#step) {
			case 0:
				this.#renderName();
				break;
			case 1:
				this.#renderKind();
				break;
			case 2:
				this.#renderInstruction();
				break;
			case 3:
				this.#renderLabels();
				break;
			case 4:
				this.#renderRisk();
				break;
		}
	}

	#renderName(): void {
		this.addChild(heading("New decision point · name", 1, this.#total));
		this.addChild(new Spacer(1));
		const field = new TextFormField({
			theme: fieldTheme,
			label: "Name",
			description: "Letters, digits, and hyphens. Becomes .ngodeai/decisions/<name>.json",
			initialValue: this.#id,
			...(this.#error ? { summary: [new Text(theme.fg("error", `✗ ${this.#error}`), 0, 0)] } : {}),
			hint: formatKeyHint("enter") + "  " + formatKeyHint("esc"),
			empty: "reject",
			emptyError: "a name is required",
			validate: value => this.#validateName(value),
			onSubmit: value => {
				this.#id = value.trim();
				this.#error = undefined;
				this.#step = 1;
				this.#render();
				this.#options.requestRender();
			},
			onCancel: () => this.#options.onCancel(),
		});
		this.addChild(field);
		this.#focus = field;
	}

	#validateName(value: string): string | undefined {
		const name = value.trim();
		if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
			return "Use letters, digits, and hyphens, starting with a letter or digit.";
		}
		if (this.#options.existing?.includes(name)) {
			return `"${name}" already exists.`;
		}
		return undefined;
	}

	#renderKind(): void {
		this.addChild(heading("New decision point · kind", 2, this.#total));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "What does this question answer?"), 0, 0));
		this.addChild(new Spacer(1));
		const items = KINDS.map(kind => ({ label: kind.label, value: kind.value, description: kind.description }));
		this.#listItems = items;
		const list = new SelectList(items, 72, getSelectListTheme(), {
			search: "never",
			renderItem: ({ item, selected }) => {
				const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
				const label = selected ? theme.fg("accent", item.label) : item.label;
				const lines = [`${prefix}${label}`];
				if (item.description) lines.push(`    ${theme.fg("dim", item.description)}`);
				return lines;
			},
		});
		list.setSelectedIndex(this.#listIndex);
		list.onSelect = item => {
			this.#kind = item.value as PointKind;
			this.#listIndex = 0;
			this.#step = 2;
			this.#render();
			this.#options.requestRender();
		};
		this.addChild(list);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", `${formatKeyHint("enter")}  ${formatKeyHint("esc")}`), 0, 0));
		this.#list = list;
		this.#focus = list;
	}

	#renderInstruction(): void {
		this.addChild(heading("New decision point · question", 3, this.#total));
		this.addChild(new Spacer(1));
		const field = new TextFormField({
			theme: fieldTheme,
			label: "Question",
			description: "One narrow question. Name the state fields it should read with backticks, e.g. `state.diff`.",
			...(this.#error ? { summary: [new Text(theme.fg("error", `✗ ${this.#error}`), 0, 0)] } : {}),
			hint: formatKeyHint("enter") + "  " + formatKeyHint("esc"),
			empty: "reject",
			emptyError: "the judge needs a question to answer",
			onSubmit: value => {
				this.#instruction = value.trim();
				this.#error = undefined;
				// A yes/no question has no labels to collect.
				this.#step = this.#kind === "yesno" ? 4 : 3;
				this.#render();
				this.#options.requestRender();
			},
			onCancel: () => {
				this.#step = 1;
				this.#render();
				this.#options.requestRender();
			},
		});
		this.addChild(field);
		this.#focus = field;
	}

	#renderLabels(): void {
		const score = this.#kind === "score";
		this.addChild(heading(`New decision point · ${score ? "levels" : "options"}`, 4, this.#total));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					score
						? "One level per line, lowest first. Two at minimum; each must be distinguishable."
						: "One option per line. Two at minimum; each must be clearly different from the others.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		const field = new TextFormField({
			theme: fieldTheme,
			label: score ? "Levels" : "Options",
			description: score ? "e.g. none, partial, complete" : "e.g. allow, ask, deny",
			initialValue: this.#labels.join(", "),
			...(this.#error ? { summary: [new Text(theme.fg("error", `✗ ${this.#error}`), 0, 0)] } : {}),
			hint: formatKeyHint("enter") + "  " + formatKeyHint("esc"),
			empty: "reject",
			emptyError: "at least two entries are required",
			validate: value => {
				const labels = value
					.split(",")
					.map(part => part.trim())
					.filter(Boolean);
				if (labels.length < 2) return "at least two entries are required";
				if (new Set(labels).size !== labels.length) return "entries must be distinct";
				return undefined;
			},
			onSubmit: value => {
				this.#labels = value
					.split(",")
					.map(part => part.trim())
					.filter(Boolean);
				this.#error = undefined;
				this.#step = 4;
				this.#render();
				this.#options.requestRender();
			},
			onCancel: () => {
				this.#step = 2;
				this.#render();
				this.#options.requestRender();
			},
		});
		this.addChild(field);
		this.#focus = field;
	}

	#renderRisk(): void {
		this.addChild(heading("New decision point · risk", 5, this.#total));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "What does acting on this answer authorize?"), 0, 0));
		this.addChild(new Spacer(1));
		const items = RISKS.map(risk => ({ label: risk.label, value: risk.value, description: risk.description }));
		this.#listItems = items;
		const list = new SelectList(items, 72, getSelectListTheme(), {
			search: "never",
			renderItem: ({ item, selected }) => {
				const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
				const label = selected ? theme.fg("accent", item.label) : item.label;
				const lines = [`${prefix}${label}`];
				if (item.description) lines.push(`    ${theme.fg("dim", item.description)}`);
				return lines;
			},
		});
		list.setSelectedIndex(this.#listIndex);
		list.onSelect = item => {
			this.#risk = item.value as PointRisk;
			void this.#finish();
		};
		// Moving the cursor updates the preview without committing: the file a risk
		// class produces differs (an irreversible point writes no threshold).
		list.onSelectionChange = item => {
			this.#risk = item.value as PointRisk;
			this.#render();
			this.#options.requestRender();
		};
		this.addChild(list);
		this.addChild(new Spacer(1));
		// The preview is the file about to be written, verbatim. Showing it before
		// the last keystroke is what makes the criteria shape legible: the user sees
		// that a score wrote an array and a choice wrote a map.
		this.addChild(new Text(theme.fg("dim", "Preview · .ngodeai/decisions/" + this.#id + ".json"), 0, 0));
		for (const line of this.#previewLines()) {
			this.addChild(new Text(theme.fg("muted", `  ${line}`), 0, 0));
		}
		this.addChild(new Spacer(1));
		if (this.#error) this.addChild(new Text(theme.fg("error", `✗ ${this.#error}`), 0, 0));
		this.addChild(new Text(theme.fg("muted", `${formatKeyHint("enter")}  ${formatKeyHint("esc")}`), 0, 0));
		this.#list = list;
		this.#focus = list;
	}

	/** The file as it would be written, split for display. */
	#previewLines(): string[] {
		const json = decisionPointJson({
			id: this.#id || "unnamed",
			kind: this.#kind,
			instruction: this.#instruction || "…",
			labels: this.#labels,
			risk: this.#risk,
		});
		return json.trimEnd().split("\n").slice(0, 14);
	}

	async #finish(): Promise<void> {
		this.#error = undefined;
		try {
			const written = await this.#options.onCreate({
				id: this.#id,
				kind: this.#kind,
				instruction: this.#instruction,
				labels: this.#labels,
				risk: this.#risk,
			});
			if (written !== undefined) this.#error = written;
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
		if (this.#error) {
			this.#render();
			this.#options.requestRender();
		}
	}
}

/**
 * The JSON a draft becomes.
 *
 * The shape is what makes the question type: a score writes its labels as an
 * array, a choice as a label→rubric map, and a yes/no writes no criteria at
 * all. Getting this wrong is the one mistake the wizard exists to prevent, so
 * it is built here rather than at the call site.
 */
export function decisionPointJson(draft: DecisionPointDraft): string {
	const criteria =
		draft.kind === "score"
			? draft.labels
			: draft.kind === "choice"
				? Object.fromEntries(draft.labels.map(label => [label, null]))
				: undefined;
	/** The threshold each risk class starts at; `irreversible` has none, by design. */
	const threshold = draft.risk === "read" ? 0.85 : draft.risk === "write" ? 0.95 : undefined;
	const file: {
		label: string;
		description: string;
		risk: PointRisk;
		autoThreshold?: number;
		questions: Record<string, { instructions: string; criteria?: unknown }>;
	} = {
		label: draft.id
			.split("-")
			.map(word => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" "),
		description: draft.instruction,
		risk: draft.risk,
		questions: {
			decision: {
				instructions: draft.instruction,
				...(criteria === undefined ? {} : { criteria }),
			},
		},
	};
	// An `irreversible` point writes no threshold at all: `undefined` would
	// serialize as `null`, and a null threshold reads as a malformed file.
	if (threshold !== undefined) file.autoThreshold = threshold;
	return `${JSON.stringify(file, null, 2)}\n`;
}
