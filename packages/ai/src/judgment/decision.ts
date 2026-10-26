/**
 * Artificial Decisions: one typed decision, as the surfaces see it.
 *
 * A {@link Judge} call answers a map of questions about a state and hands the
 * answers back to code. That is the whole contract, and it is deliberately
 * narrow: code owns the control flow, and the judge only fills in the parts
 * that need common-sense judgment.
 *
 * This module widens that contract by exactly one field — *what the answer was
 * used for*. A {@link DecisionEvent} is a judgment plus the decision it fed:
 * the point it belongs to, the answer the code acted on, and what happened
 * next. Nothing here changes how a judgment runs; it only records one.
 *
 * The event is what makes the layer inspectable. Without it a decision is
 * invisible the moment it is made: the answer is a local variable inside a
 * classifier, and the only trace is a cache row keyed by a state hash.
 *
 * @example
 * ```ts ignore
 * const event = decisionFromResult("tool_approval", request, result, {
 *   action: "gated",
 *   tier: "card",
 * });
 * ledger.append(event);
 * ```
 */
import type {
	Answer,
	ChoiceAnswer,
	NoulAnswer,
	Question,
	Questions,
	ScoreAnswer,
	JudgmentRequest,
	JudgmentResult,
} from "./types";

/**
 * What happened because of the answer.
 *
 * - `auto` — code acted on the answer with no human in the loop.
 * - `gated` — the answer sent the decision to a human (approval, review).
 * - `asked` — the answer was itself a question for a human.
 * - `skipped` — the answer was ignored; a deterministic rule won.
 * - `silent` — the answer was recorded but changed nothing the user can see.
 * - `blocked` — the answer stopped an action.
 */
export type DecisionAction = "auto" | "gated" | "asked" | "skipped" | "silent" | "blocked";

/**
 * How much of the transcript a decision earns.
 *
 * - `silent` — nothing in the transcript; the session aggregate counts it.
 * - `line` — one row, because it changed what the agent did.
 * - `card` — an expandable card, because a human was involved or the model
 *   was unsure enough that the answer deserves its probabilities on screen.
 */
export type DecisionTier = "silent" | "line" | "card";

/** Which side of the fork a decision guards, used to pick its risk threshold. */
export type DecisionRisk = "read" | "write" | "irreversible";

/**
 * One decision point: a stable name, a question file, and the thresholds its
 * answers are held to. A point is the unit a user enables, disables, or tunes.
 */
export interface DecisionPoint {
	/** Stable id, e.g. `tool_approval`. Names the ledger rows and the settings key. */
	id: string;
	/** Human label for `/decisions`; falls back to {@link id}. */
	label?: string;
	/** One sentence on what the answer changes. */
	description?: string;
	/** Risk class of the action the answer authorizes. */
	risk?: DecisionRisk;
	/** Minimum confidence at which code acts without asking. */
	autoThreshold?: number;
	/** Confidence below which the decision goes to a human instead of acting. */
	escalateThreshold?: number;
	/** Transcript tier when the answer is confident. */
	tier?: DecisionTier;
	/** Whether this point runs at all. */
	enabled?: boolean;
}

/** A question as the ledger stores it: enough to re-ask it, without the caller's types. */
export interface DecisionQuestionRecord {
	id: string;
	type: Question["type"];
	instructions: string;
	/** Option labels, score levels, or the noul rubric; `null` when the type needs none. */
	criteria?: unknown;
}

/** One answer as the ledger stores it, flattened for rendering and querying. */
export interface DecisionAnswerRecord {
	question: string;
	type: Answer["type"];
	/** Selected option, position on the scale, or P(yes). */
	value: string | number;
	/** Full distribution when the answer carries one. */
	probabilities?: Record<string, number>;
	confidence?: number;
}

/**
 * What a decision did, in one row.
 *
 * The event is immutable once built: a decision happened at a moment, and
 * rewriting it later would break the one thing the ledger is for — being able
 * to check what the agent was told before it acted.
 */
export interface DecisionEvent {
	/** Monotonic id within the session, assigned by the ledger. */
	id?: number;
	/** Session the decision belongs to. */
	sessionId?: string;
	/** Epoch milliseconds when the judgment returned. */
	at: number;
	/** {@link DecisionPoint.id} this decision belongs to. */
	point: string;
	/** Backend that answered, e.g. `jev-1.14.0`. */
	model: string;
	/** Transport that answered, e.g. `typesafe`. */
	api: string;
	/** Provider that served it. */
	provider: string;
	/** Questions asked, in request order. */
	questions: readonly DecisionQuestionRecord[];
	/** Answers, keyed by question id. */
	answers: readonly DecisionAnswerRecord[];
	/** What code did with the answers. */
	action: DecisionAction;
	/** Transcript tier this decision earned. */
	tier: DecisionTier;
	/** Risk class of the guarded action, when the point declares one. */
	risk?: DecisionRisk;
	/** Lowest confidence among the answers the action depended on; the number a threshold is compared to. */
	confidence?: number;
	/** Which answer keys the action depended on, when it did not depend on all of them. */
	decisionKeys?: readonly string[];
	/** One line explaining the outcome, in the code's words rather than the model's. */
	reason?: string;
	/** Wall-clock milliseconds the judgment took, cache hits included. */
	elapsedMs?: number;
	/** Billed cost in USD; zero for a cache hit. */
	cost?: number;
	/** Input tokens the request carried. */
	inputTokens?: number;
	/** Whether every answer came from the local answer cache. */
	cached?: boolean;
	/** Questions answered from cache, when the request was partly cached. */
	cachedQuestions?: number;
	/** Batch this decision was asked with; decisions from one request share it. */
	batchId?: string;
	/** The exact state the judge saw. Omitted when the caller opts out of keeping it. */
	state?: unknown;
	/** Content-addressed state digest, so two decisions over the same state are comparable without storing it twice. */
	stateDigest?: string;
	/** A code-side disagreement with the answer, e.g. a verification that failed after a `pass`. */
	conflict?: string;
}

/** Where a decision came from, when it was not a live judgment. */
export type DecisionSource = "live" | "cache" | "replay";

/** One question's answer, flattened from the typed answer union. */
export function decisionAnswerRecord(id: string, answer: Answer): DecisionAnswerRecord {
	switch (answer.type) {
		case "choice": {
			const choice = answer as ChoiceAnswer;
			return {
				question: id,
				type: "choice",
				value: choice.choice,
				probabilities: choice.probabilities,
				confidence: choice.confidence,
			};
		}
		case "score": {
			const score = answer as ScoreAnswer;
			return {
				question: id,
				type: "score",
				value: score.score,
				probabilities: score.probabilities,
				confidence: score.confidence,
			};
		}
		case "noul": {
			const noul = answer as NoulAnswer;
			return { question: id, type: "noul", value: noul.noul };
		}
		case "box": {
			const box = answer as {
				box: { top: number; bottom: number; left: number; right: number };
				confidence: number;
			};
			return {
				question: id,
				type: "box",
				value: [box.box.top, box.box.bottom, box.box.left, box.box.right].map(n => n.toFixed(3)).join(","),
				confidence: box.confidence,
			};
		}
	}
}

/** A question as the ledger stores it. */
export function decisionQuestionRecord(id: string, question: Question): DecisionQuestionRecord {
	const record: DecisionQuestionRecord = {
		id,
		type: question.type,
		instructions: question.instructions,
	};
	if (question.type !== "box" && question.criteria !== undefined) record.criteria = question.criteria;
	return record;
}

/**
 * The confidence a threshold should be compared against.
 *
 * A Choice and a Score carry their own `confidence`; a Noul does not, and its
 * distance from 0.5 is the same statistic expressed on the same 0–1 scale, so
 * a single threshold works across question types. Returns `undefined` when the
 * keys name no answer, so a caller cannot accidentally compare a threshold
 * against nothing and treat it as confident.
 */
export function decisionConfidence(
	answers: readonly DecisionAnswerRecord[],
	keys?: readonly string[],
): number | undefined {
	const considered = keys ? answers.filter(answer => keys.includes(answer.question)) : answers;
	if (considered.length === 0) return undefined;
	let lowest: number | undefined;
	for (const answer of considered) {
		const confidence =
			answer.confidence ?? (typeof answer.value === "number" ? Math.abs(2 * answer.value - 1) : undefined);
		if (confidence === undefined) continue;
		lowest = lowest === undefined ? confidence : Math.min(lowest, confidence);
	}
	return lowest;
}

/** Content digest of a state, matching the answer cache's identity so the two can be cross-referenced. */
export function decisionStateDigest(state: JudgmentRequest["state"]): string {
	const canonical = canonicalJson(state);
	return new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
}

/** Stable JSON: object keys sorted, so two equal states always digest the same. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Timing the judge observed, passed to a {@link DecisionScope} when a request finishes. */
export interface DecisionTiming {
	/** Epoch milliseconds when the request started. */
	startedAt: number;
	/** Epoch milliseconds when the answers came back. */
	finishedAt: number;
	/** Whether every answer came from the local answer cache. */
	cached?: boolean;
	/** Questions answered from cache, when the request was partly cached. */
	cachedQuestions?: number;
}

/**
 * A decision in flight: opened before a judgment, settled after the caller has
 * decided what to do with the answers.
 *
 * The two-phase shape exists because the outcome is only knowable after the
 * answer. A tool-approval gate cannot say whether it will auto-allow, ask, or
 * deny until it has read the probabilities, and a classifier cannot say which
 * route it took until it has compared them to its thresholds. Opening the
 * scope first lets the judge attach the request and the timing; settling last
 * lets the caller record what actually happened.
 *
 * A scope that is never settled still yields an event, marked `silent`: a
 * decision that ran and was not described is still a decision that ran, and
 * dropping it would make the ledger's totals lie.
 */
export interface DecisionScope {
	/** The point this decision belongs to. */
	readonly point: string;
	/** Risk class of the action the answer authorizes. */
	readonly risk?: DecisionRisk;
	/** Default tier when the caller does not override it at settle time. */
	readonly tier?: DecisionTier;
	/** Question ids the action will depend on. */
	readonly decisionKeys?: readonly string[];
	/** Batch this request is part of. */
	readonly batchId?: string;
	/** Keep the raw state on the event. */
	readonly keepState?: boolean;
	/** Called by the judge with the completed request. Idempotent per scope. */
	complete(request: JudgmentRequest, result: JudgmentResult, timing: DecisionTiming): void;
	/** Called by the judge when the request failed; records nothing unless a result was seen. */
	fail(error: unknown): void;
	/** Record the outcome. Call once, after acting on the answers. */
	settle(outcome: DecisionOutcome): DecisionEvent | undefined;
}

/** Options a caller adds to a judgment result to describe the decision it fed. */
export interface DecisionOutcome {
	action: DecisionAction;
	tier?: DecisionTier;
	risk?: DecisionRisk;
	/** Question ids the action depended on; omitted means all of them. */
	decisionKeys?: readonly string[];
	reason?: string;
	conflict?: string;
	batchId?: string;
	/** Keep the state on the event. Off by default: the digest is enough to correlate. */
	keepState?: boolean;
}

/**
 * Build a {@link DecisionEvent} from a completed judgment.
 *
 * Tier defaults to `line` for an action and `silent` for a no-op, so a caller
 * that says nothing about presentation gets the conservative choice: visible
 * when it changed something, quiet when it did not.
 */
export function decisionFromResult<Q extends Questions>(
	point: string,
	request: JudgmentRequest<Q>,
	result: JudgmentResult<Q>,
	outcome: DecisionOutcome,
	extra: {
		at?: number;
		elapsedMs?: number;
		sessionId?: string;
		cached?: boolean;
		cachedQuestions?: number;
		model?: string;
		api?: string;
		provider?: string;
	} = {},
): DecisionEvent {
	const questions: DecisionQuestionRecord[] = [];
	for (const id in request.questions) questions.push(decisionQuestionRecord(id, request.questions[id]));
	const answers: DecisionAnswerRecord[] = [];
	for (const id in result.answers) answers.push(decisionAnswerRecord(id, result.answers[id]));

	const event: DecisionEvent = {
		at: extra.at ?? Date.now(),
		point,
		model: extra.model ?? result.model,
		api: extra.api ?? result.api,
		provider: extra.provider ?? result.provider,
		questions,
		answers,
		action: outcome.action,
		tier: outcome.tier ?? (outcome.action === "silent" || outcome.action === "skipped" ? "silent" : "line"),
		confidence: decisionConfidence(answers, outcome.decisionKeys),
		cost: result.usage.cost.total,
		inputTokens: result.usage.input,
	};
	if (outcome.risk !== undefined) event.risk = outcome.risk;
	if (outcome.decisionKeys !== undefined) event.decisionKeys = outcome.decisionKeys;
	if (outcome.reason !== undefined) event.reason = outcome.reason;
	if (outcome.conflict !== undefined) event.conflict = outcome.conflict;
	if (outcome.batchId !== undefined) event.batchId = outcome.batchId;
	if (extra.elapsedMs !== undefined) event.elapsedMs = extra.elapsedMs;
	if (extra.sessionId !== undefined) event.sessionId = extra.sessionId;
	if (extra.cached !== undefined) event.cached = extra.cached;
	if (extra.cachedQuestions !== undefined) event.cachedQuestions = extra.cachedQuestions;
	if (outcome.keepState) event.state = request.state;
	event.stateDigest = decisionStateDigest(request.state);
	return event;
}

/** Receives settled decisions. The ledger is one sink; a test's array is another. */
export type DecisionSink = (event: DecisionEvent) => void;

/** Options for opening a scope. */
export interface DecisionOpenOptions {
	/** Risk class of the guarded action. */
	risk?: DecisionRisk;
	/** Default transcript tier. */
	tier?: DecisionTier;
	/** Question ids the action will depend on. */
	decisionKeys?: readonly string[];
	/** Batch id shared by decisions from one request. */
	batchId?: string;
	/** Keep the raw state on the event. Off by default. */
	keepState?: boolean;
	/** Session id stamped on the event. */
	sessionId?: string;
}

/**
 * Opens {@link DecisionScope}s and forwards settled events to a sink.
 *
 * The recorder is the only place that knows where decisions go. A session
 * wires it to the ledger and the transcript; a test wires it to an array. That
 * keeps the judge free of any storage or rendering concern: it sees a scope,
 * reports a result to it, and is done.
 *
 * ```ts ignore
 * const scope = recorder.open("tool_approval", { risk: "write" });
 * const result = await judge.judge(request, { decision: scope });
 * const verdict = result.answers.allowed.choice;
 * scope.settle({ action: verdict === "allow" ? "auto" : "gated", reason: "..." });
 * ```
 */
export class DecisionRecorder {
	readonly #sink: DecisionSink;
	readonly #sessionId: string | undefined;
	readonly #silent: boolean;

	constructor(sink: DecisionSink, sessionId?: string, silent = false) {
		this.#sink = sink;
		this.#sessionId = sessionId;
		this.#silent = silent;
	}

	/**
	 * A recorder that drops every decision, for paths that must not record.
	 *
	 * Its scopes settle to `undefined` rather than an event, so a caller that
	 * branches on "did this get recorded?" sees the truth instead of an event
	 * that was thrown away.
	 */
	static silent(): DecisionRecorder {
		return new DecisionRecorder(() => {}, undefined, true);
	}

	/** Whether this recorder drops what it is given. */
	get silent(): boolean {
		return this.#silent;
	}

	/** Open a decision. The returned scope is settled by the caller after acting. */
	open(point: string, options: DecisionOpenOptions = {}): DecisionScope {
		if (this.#silent) {
			return {
				point,
				complete() {},
				fail() {},
				settle: () => undefined,
			};
		}
		const sink = this.#sink;
		const sessionId = options.sessionId ?? this.#sessionId;
		let request: JudgmentRequest | undefined;
		let result: JudgmentResult | undefined;
		let timing: DecisionTiming | undefined;
		let settled = false;

		return {
			point,
			...(options.risk === undefined ? {} : { risk: options.risk }),
			...(options.tier === undefined ? {} : { tier: options.tier }),
			...(options.decisionKeys === undefined ? {} : { decisionKeys: options.decisionKeys }),
			...(options.batchId === undefined ? {} : { batchId: options.batchId }),
			...(options.keepState === undefined ? {} : { keepState: options.keepState }),

			/**
			 * The first completed request defines the event; later ones add to its
			 * cost and timing.
			 *
			 * A fan-out decision (the `find` cascade, a batch of rule checks) makes
			 * many requests that belong to one decision. Keeping the first request
			 * as the representative and summing the rest is what lets one row stand
			 * for the whole wave without inventing a synthetic question set.
			 */
			complete(nextRequest, nextResult, nextTiming) {
				if (!request || !result || !timing) {
					request = nextRequest;
					result = nextResult;
					timing = nextTiming;
					return;
				}
				timing = {
					...timing,
					finishedAt: nextTiming.finishedAt,
					cached: timing.cached === true && nextTiming.cached === true,
				};
			},

			fail() {
				// A failed judgment produced no answers to record; the ledger holds
				// decisions, not attempts. Failures surface through telemetry.
			},

			settle(outcome) {
				if (settled) return undefined;
				settled = true;
				if (!request || !result || !timing) return undefined;
				const event = decisionFromResult(
					point,
					request,
					result,
					{
						...outcome,
						...(options.risk !== undefined && outcome.risk === undefined ? { risk: options.risk } : {}),
						...(options.tier !== undefined && outcome.tier === undefined ? { tier: options.tier } : {}),
						...(options.decisionKeys !== undefined && outcome.decisionKeys === undefined
							? { decisionKeys: options.decisionKeys }
							: {}),
						...(options.batchId !== undefined && outcome.batchId === undefined
							? { batchId: options.batchId }
							: {}),
						...(options.keepState !== undefined && outcome.keepState === undefined
							? { keepState: options.keepState }
							: {}),
					},
					{
						...(sessionId === undefined ? {} : { sessionId }),
						elapsedMs: Math.max(0, timing.finishedAt - timing.startedAt),
						...(timing.cached === undefined ? {} : { cached: timing.cached }),
						...(timing.cachedQuestions === undefined ? {} : { cachedQuestions: timing.cachedQuestions }),
					},
				);
				sink(event);
				return event;
			},
		};
	}
}
