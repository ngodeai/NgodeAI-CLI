/**
 * Settings for the Artificial Decisions layer.
 *
 * Two knobs, both conservative by default:
 *
 * - {@link cfgDecisionsEnabled} turns recording on. When off, decision points
 *   receive a silent recorder and behave exactly as they did before this
 *   layer existed.
 * - {@link cfgDecisionsThresholds} holds the confidence matrix. It is a single
 *   record rather than nine settings so a deployment can copy one block
 *   between configs, and so `/decisions status` can print exactly what it read.
 *
 * Thresholds are per *risk class*, not per point. A read may auto-proceed on a
 * clear answer; a write needs near-certainty; an irreversible action never
 * proceeds automatically. The last one is enforced in code, not by the value
 * here: raising it cannot make a delete auto-approve.
 */
import { register } from "../config/registry";

export const cfgDecisionsEnabled = register({
	id: "decisions.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Artificial Decisions",
		label: "Record Decisions",
		description:
			"Keep every typed decision in the session ledger and show the ones that changed the agent's path. Turning this off leaves the agent's behavior unchanged; it only stops recording.",
	},
});

export const cfgDecisionsShowLines = register({
	id: "decisions.showLines",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Artificial Decisions",
		label: "Show Decision Lines",
		description: "Print a one-line row in the transcript for decisions that changed what the agent did.",
	},
});

export const cfgDecisionsShowCards = register({
	id: "decisions.showCards",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Artificial Decisions",
		label: "Show Decision Cards",
		description:
			"Show an expandable card when a decision reached a human or the model was unsure. Off keeps those decisions in /decisions only.",
	},
});

export const cfgDecisionsStatusSegment = register({
	id: "decisions.statusSegment",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Artificial Decisions",
		label: "Status Line Counter",
		description: "Show the session's decision count in the status line.",
	},
});

/** One risk class's thresholds: act at or above `auto`, refuse below `escalate`. */
export interface DecisionThresholds {
	auto: number;
	escalate: number;
}

/** The full matrix, keyed by risk class. */
export type DecisionThresholdMatrix = Record<"read" | "write" | "irreversible", DecisionThresholds>;

/** Defaults; see {@link cfgDecisionsThresholds}. */
export const DEFAULT_DECISION_THRESHOLDS: DecisionThresholdMatrix = {
	read: { auto: 0.85, escalate: 0.3 },
	write: { auto: 0.95, escalate: 0.4 },
	// Never auto-approves. Enforced structurally in `DecisionLayer.gate`.
	irreversible: { auto: Number.POSITIVE_INFINITY, escalate: 0.5 },
};

export const cfgDecisionsThresholds = register({
	id: "decisions.thresholds",
	type: "record",
	default: DEFAULT_DECISION_THRESHOLDS,
	ui: {
		tab: "interaction",
		group: "Artificial Decisions",
		label: "Confidence Thresholds",
		description:
			"Per-risk confidence gates. `auto` is the confidence at which code acts without asking; `escalate` is the floor below which it refuses. Irreversible actions never auto-approve, whatever `auto` says.",
	},
});

/**
 * The matrix as configured, with every entry validated.
 *
 * A malformed entry falls back to its default rather than throwing: a bad
 * threshold must not stop a session from starting, and the conservative
 * default is always safe to fall back to. `irreversible.auto` is forced to
 * infinity after the read, so no configuration can widen it.
 */
export function resolveDecisionThresholds(raw: unknown): DecisionThresholdMatrix {
	const resolved: DecisionThresholdMatrix = {
		read: { ...DEFAULT_DECISION_THRESHOLDS.read },
		write: { ...DEFAULT_DECISION_THRESHOLDS.write },
		irreversible: { ...DEFAULT_DECISION_THRESHOLDS.irreversible },
	};
	if (typeof raw !== "object" || raw === null) return resolved;
	for (const risk of ["read", "write", "irreversible"] as const) {
		const entry = (raw as Record<string, unknown>)[risk];
		if (typeof entry !== "object" || entry === null) continue;
		const { auto, escalate } = entry as Record<string, unknown>;
		if (typeof auto === "number" && Number.isFinite(auto) && auto >= 0 && auto <= 1) {
			resolved[risk].auto = auto;
		}
		if (typeof escalate === "number" && Number.isFinite(escalate) && escalate >= 0 && escalate <= 1) {
			resolved[risk].escalate = escalate;
		}
	}
	resolved.irreversible.auto = Number.POSITIVE_INFINITY;
	return resolved;
}
