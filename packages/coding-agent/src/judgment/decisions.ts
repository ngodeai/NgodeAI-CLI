/**
 * Artificial Decisions: the session's decision layer.
 *
 * This is the seam between a judgment and the surfaces that show it. Three
 * things meet here:
 *
 * - the **recorder**, which the judge sees (`DecisionRecorder.open`) and the
 *   caller settles once it has acted on the answers;
 * - the **ledger**, which keeps every settled decision for `/decisions`;
 * - the **event stream**, which carries a decision to the transcript the moment
 *   it is settled, so a gate appears while it is still relevant.
 *
 * Nothing in the agent loop needs to know about any of the three. A decision
 * point asks for a scope, passes it as `options.decision`, and settles it. If
 * the layer is disabled, {@link DecisionLayer.silent} hands back a recorder
 * that drops everything and the point behaves exactly as it did before.
 *
 * ## Tiers
 *
 * A decision earns transcript space by what it did, not by what it is. Routine
 * checks that agreed with code stay out of the transcript entirely and only
 * reach the ledger; a decision that changed the agent's path, or that a human
 * had to make, gets a row or a card. The point declares its default and the
 * caller can override it at settle time — a `ttsr` pass is silent while a
 * `ttsr` violation is a line.
 *
 * ## Thresholds
 *
 * Confidence gates live on the point, not on the answer: the same probability
 * is enough to auto-approve a read and never enough to auto-approve a delete.
 * {@link DecisionLayer.gate} applies the point's matrix and reports which side
 * of it the answer landed on, so callers do not re-implement the comparison.
 */
import type { DecisionEvent, DecisionOutcome, DecisionRecorder, DecisionRisk, DecisionTier } from "@ngodeai/ai";
import { DecisionRecorder as Recorder } from "@ngodeai/ai";
import type { Settings } from "../config/settings";
import { logger } from "@ngodeai/utils";
import { type DecisionFilter, type DecisionLedger, sharedDecisionLedger } from "./ledger";
import {
	cfgDecisionsEnabled,
	cfgDecisionsThresholds,
	DEFAULT_DECISION_THRESHOLDS,
	type DecisionThresholdMatrix,
	resolveDecisionThresholds,
} from "./settings";

/** The decision points this build ships, in the order `/decisions` lists them. */
export const DECISION_POINTS = [
	"tool_approval",
	"verify_edit",
	"route_task",
	"thinking_level",
	"unexpected_stop",
	"ttsr",
	"find",
	"git_stage",
	"chart",
	"compress",
	"completion",
	"autolearn",
] as const;

/** One of the shipped decision points. */
export type DecisionPointId = (typeof DECISION_POINTS)[number];

/** Risk class per point: what the answer authorizes, not what it is about. */
const POINT_RISK: Readonly<Record<string, DecisionRisk>> = {
	tool_approval: "write",
	verify_edit: "write",
	route_task: "read",
	thinking_level: "read",
	unexpected_stop: "read",
	ttsr: "read",
	find: "read",
	git_stage: "write",
	chart: "read",
	compress: "write",
	completion: "read",
	autolearn: "read",
};

/** Which side of the point's matrix an answer landed on. */
export type GateVerdict = "auto" | "ask" | "block";

/** A gate decision: what the matrix says to do, and why. */
export interface GateResult {
	verdict: GateVerdict;
	/** Confidence compared, or `undefined` when no answer carried one. */
	confidence: number | undefined;
	/** The threshold the confidence was compared to. */
	autoThreshold: number;
	/** The floor below which the decision is refused outright. */
	escalateThreshold: number;
	/** One line naming the rule that produced the verdict. */
	reason: string;
}

/**
 * The decision layer for one session.
 *
 * Constructed once per session; {@link silent} for sessions that must not
 * record (tests, `--no-decisions`, subagents that should not double-count).
 */
export class DecisionLayer {
	readonly #recorder: DecisionRecorder;
	readonly #ledger: DecisionLedger | undefined;
	readonly #sessionId: string | undefined;
	readonly #emit: ((event: DecisionEvent) => void) | undefined;
	readonly #thresholds: DecisionThresholdMatrix;
	readonly #enabled: boolean;

	private constructor(options: {
		ledger: DecisionLedger | undefined;
		sessionId: string | undefined;
		emit: ((event: DecisionEvent) => void) | undefined;
		thresholds: DecisionThresholdMatrix;
		enabled: boolean;
	}) {
		this.#ledger = options.ledger;
		this.#sessionId = options.sessionId;
		this.#emit = options.emit;
		this.#enabled = options.enabled;
		this.#thresholds = options.thresholds;
		this.#recorder = options.enabled
			? new Recorder(event => this.#onDecision(event), options.sessionId)
			: Recorder.silent();
	}

	/** A layer that records and emits nothing; every scope settles to `undefined`. */
	static silent(): DecisionLayer {
		return new DecisionLayer({
			ledger: undefined,
			sessionId: undefined,
			emit: undefined,
			thresholds: resolveDecisionThresholds(undefined),
			enabled: false,
		});
	}

	/**
	 * A layer bound to the shared ledger and a session event sink.
	 *
	 * `emit` runs synchronously inside {@link DecisionScope.settle}, before the
	 * ledger write, so a gated decision reaches the transcript without waiting
	 * for SQLite.
	 */
	static open(
		options: {
			sessionId?: string;
			emit?: (event: DecisionEvent) => void;
			settings?: Settings;
			ledger?: DecisionLedger | undefined;
		} = {},
	): DecisionLayer {
		const ledger = options.ledger === undefined ? sharedDecisionLedger() : options.ledger;
		const enabled = options.settings === undefined || cfgDecisionsEnabled.get(options.settings);
		if (!enabled) return DecisionLayer.silent();
		return new DecisionLayer({
			ledger,
			sessionId: options.sessionId,
			emit: options.emit,
			thresholds: resolveDecisionThresholds(
				options.settings === undefined ? undefined : cfgDecisionsThresholds.get(options.settings),
			),
			enabled: true,
		});
	}

	/**
	 * Record an already-built event.
	 *
	 * Some call sites cannot open a scope before acting — the approval gate
	 * knows its risk only once it has resolved the call — so they build the
	 * event themselves and hand it here. Same sink, same ledger, same counters.
	 */
	record(event: DecisionEvent): void {
		this.#onDecision(event);
	}

	/** Open a decision scope for `point`. */
	open(point: string, options: Parameters<DecisionRecorder["open"]>[1] = {}) {
		return this.#recorder.open(point, options);
	}

	/** Whether this layer records anything. */
	get enabled(): boolean {
		return this.#enabled;
	}

	/**
	 * Apply the point's confidence matrix.
	 *
	 * `irreversible` never auto-approves: its `auto` threshold is infinite, so
	 * the comparison can only ever land on `ask`. That is a structural
	 * guarantee rather than a large number someone could raise.
	 */
	gate(point: string, confidence: number | undefined, risk?: DecisionRisk): GateResult {
		const resolvedRisk = risk ?? POINT_RISK[point] ?? "read";
		const { auto, escalate } = this.#thresholds[resolvedRisk];
		if (confidence === undefined) {
			return {
				verdict: "ask",
				confidence: undefined,
				autoThreshold: auto,
				escalateThreshold: escalate,
				reason: "no calibrated answer to compare",
			};
		}
		if (confidence < escalate) {
			return {
				verdict: "block",
				confidence,
				autoThreshold: auto,
				escalateThreshold: escalate,
				reason: `confidence ${confidence.toFixed(2)} is below the ${resolvedRisk} floor ${escalate.toFixed(2)}`,
			};
		}
		if (confidence >= auto) {
			return {
				verdict: "auto",
				confidence,
				autoThreshold: auto,
				escalateThreshold: escalate,
				reason: `confidence ${confidence.toFixed(2)} clears the ${resolvedRisk} threshold ${auto.toFixed(2)}`,
			};
		}
		const threshold = Number.isFinite(auto) ? auto.toFixed(2) : "never";
		return {
			verdict: "ask",
			confidence,
			autoThreshold: auto,
			escalateThreshold: escalate,
			reason: `confidence ${confidence.toFixed(2)} is under the ${resolvedRisk} threshold ${threshold}`,
		};
	}

	/** The configured thresholds, for `/decisions status`. */
	get thresholds(): Readonly<DecisionThresholdMatrix> {
		return this.#thresholds;
	}

	/** Decisions for this session, newest first. */
	list(filter: Omit<DecisionFilter, "session"> = {}): DecisionEvent[] {
		return this.#ledger?.list({ ...filter, session: this.#sessionId }) ?? [];
	}

	/** Session totals for the status line and `/decisions` header. */
	totals(filter: Omit<DecisionFilter, "session"> = {}) {
		return (
			this.#ledger?.totals({ ...filter, session: this.#sessionId }) ?? {
				count: 0,
				cost: 0,
				elapsedMs: 0,
				inputTokens: 0,
				gated: 0,
				conflicts: 0,
				cached: 0,
			}
		);
	}

	/** Per-point aggregates for `/decisions`. */
	points(filter: Omit<DecisionFilter, "session"> = {}) {
		return this.#ledger?.points({ ...filter, session: this.#sessionId }) ?? [];
	}

	/** One decision by row id, with its state. */
	get(id: number): DecisionEvent | undefined {
		return this.#ledger?.get(id);
	}

	/** The ledger behind this layer, for callers that need a raw query. */
	get ledger(): DecisionLedger | undefined {
		return this.#ledger;
	}

	/**
	 * Counts for the status line, maintained in memory.
	 *
	 * The status line repaints on every keystroke, so a SQLite aggregate per
	 * frame is out of the question. These counters are incremented where the
	 * event is appended, which makes them exact for the session and free to
	 * read.
	 */
	#counts = { count: 0, gated: 0 };

	/** Decisions recorded this session, for the status line. */
	get counts(): { count: number; gated: number } {
		return this.#counts;
	}

	#onDecision(event: DecisionEvent): void {
		if (!this.#enabled) return;
		this.#counts.count++;
		if (event.action === "gated" || event.action === "asked") this.#counts.gated++;
		if (event.tier !== "silent") {
			try {
				this.#emit?.(event);
			} catch (error) {
				logger.warn("decision emit failed", { error: String(error), point: event.point });
			}
		}
		const id = this.#ledger?.append(event);
		if (id !== undefined) event.id = id;
	}
}

/** Build a settle outcome for a gate result, in the vocabulary the ledger uses. */
export function outcomeForGate(
	gate: GateResult,
	tier: DecisionTier,
	extra: Partial<DecisionOutcome> = {},
): DecisionOutcome {
	return {
		action: gate.verdict === "auto" ? "auto" : gate.verdict === "block" ? "blocked" : "gated",
		tier,
		reason: gate.reason,
		...extra,
	};
}
