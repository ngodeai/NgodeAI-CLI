/**
 * The decision ledger: every decision the agent made, in the order it made
 * them, queryable after the fact.
 *
 * The judgment answer cache already stores answers, but it stores them by
 * *state* — it answers "have I seen this state before?" and nothing else. It
 * cannot answer "what did the agent decide at 12:02, and why did it ask me?"
 * because it never records the decision, only the answer.
 *
 * This ledger records the other half:
 *
 * ```text
 * decisions (id, session, at, point, action, tier, risk, confidence, model, …)
 * questions (decision → id, type, instructions, criteria)
 * answers   (decision → question, type, value, probabilities, confidence)
 * states    (digest, state)            -- shared with nothing; kept for `s`
 * ```
 *
 * Questions and answers are child rows rather than one JSON blob so a query
 * like "every decision where `tool_approval` said `deny`" is an index lookup
 * instead of a full scan with a JSON parser.
 *
 * Everything here is best-effort: a decision that cannot be recorded still
 * happened, and losing the record must never fail the turn.
 */
import type { Database, Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DecisionAnswerRecord, DecisionEvent, DecisionQuestionRecord } from "@ngodeai/ai";
import {
	checkpointWal,
	getDecisionsDbPath,
	isBunTestRuntime,
	logger,
	openSqliteDatabaseSync,
	postmortem,
} from "@ngodeai/utils";

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS states (
	digest TEXT PRIMARY KEY,
	state TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session TEXT,
	at INTEGER NOT NULL,
	point TEXT NOT NULL,
	action TEXT NOT NULL,
	tier TEXT NOT NULL,
	risk TEXT,
	confidence REAL,
	model TEXT NOT NULL,
	api TEXT NOT NULL,
	provider TEXT NOT NULL,
	reason TEXT,
	conflict TEXT,
	elapsed_ms INTEGER,
	cost REAL NOT NULL DEFAULT 0,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	cached INTEGER NOT NULL DEFAULT 0,
	cached_questions INTEGER,
	batch TEXT,
	state_digest TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session, id);
CREATE INDEX IF NOT EXISTS idx_decisions_point ON decisions(point);
CREATE INDEX IF NOT EXISTS idx_decisions_batch ON decisions(batch);
CREATE TABLE IF NOT EXISTS questions (
	decision INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
	ordinal INTEGER NOT NULL,
	name TEXT NOT NULL,
	type TEXT NOT NULL,
	instructions TEXT NOT NULL,
	criteria TEXT,
	PRIMARY KEY (decision, ordinal)
);
CREATE TABLE IF NOT EXISTS answers (
	decision INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
	ordinal INTEGER NOT NULL,
	question TEXT NOT NULL,
	type TEXT NOT NULL,
	value TEXT NOT NULL,
	probabilities TEXT,
	confidence REAL,
	PRIMARY KEY (decision, ordinal)
);
`;

/** Filter for {@link DecisionLedger.list}. All fields are optional and AND together. */
export interface DecisionFilter {
	/** Session id; omitted lists across every session in the store. */
	session?: string;
	/** Only these points. */
	points?: readonly string[];
	/** Only these actions. */
	actions?: readonly string[];
	/** Only these tiers. */
	tiers?: readonly string[];
	/** Only decisions at or after this epoch-millisecond timestamp. */
	since?: number;
	/** Only decisions that disagree with code. */
	conflictsOnly?: boolean;
	/** Maximum rows, newest first. Defaults to 100. */
	limit?: number;
	/** Rows to skip, for paging. */
	offset?: number;
}

/** Session-level totals the status line and `/decisions` header show. */
export interface DecisionTotals {
	count: number;
	cost: number;
	elapsedMs: number;
	inputTokens: number;
	/** Decisions that reached a human. */
	gated: number;
	/** Decisions where code disagreed with the answer. */
	conflicts: number;
	/** Decisions answered wholly from cache. */
	cached: number;
}

/** One point's row in the `/decisions` summary. */
export interface DecisionPointSummary {
	point: string;
	count: number;
	cost: number;
	elapsedMs: number;
	/** Mean confidence across the decisions that carry one. */
	meanConfidence: number | undefined;
	gated: number;
}

let shared: DecisionLedger | null | undefined;

/**
 * Process-wide ledger at {@link getDecisionsDbPath}, opened on first use and
 * closed at exit. `undefined` when the database cannot be opened (logged once;
 * decisions proceed unrecorded) and under the test runner, where a test's
 * decisions must never land in the developer's real ledger.
 */
export function sharedDecisionLedger(): DecisionLedger | undefined {
	if (isBunTestRuntime()) return undefined;
	if (shared === undefined) {
		try {
			const ledger = DecisionLedger.open();
			postmortem.register("decision-ledger", () => ledger.close(), { exitOnly: true });
			shared = ledger;
		} catch (error) {
			logger.warn("decision ledger unavailable; decisions run unrecorded", { error: String(error) });
			shared = null;
		}
	}
	return shared ?? undefined;
}

/** SQLite store of decision events. */
export class DecisionLedger {
	readonly #db: Database;
	readonly #insertDecision: Statement<
		{ id: number },
		[
			string | null,
			number,
			string,
			string,
			string,
			string | null,
			number | null,
			string,
			string,
			string,
			string | null,
			string | null,
			number | null,
			number,
			number,
			number,
			number | null,
			string | null,
			string | null,
		]
	>;
	readonly #insertQuestion: Statement<unknown, [number, number, string, string, string, string | null]>;
	readonly #insertAnswer: Statement<unknown, [number, number, string, string, string, string | null, number | null]>;
	readonly #insertState: Statement<unknown, [string, string, number]>;

	private constructor(db: Database) {
		this.#db = db;
		db.run(SCHEMA);
		this.#insertDecision = db.prepare(`
INSERT INTO decisions (
	session, at, point, action, tier, risk, confidence, model, api, provider,
	reason, conflict, elapsed_ms, cost, input_tokens, cached, cached_questions, batch, state_digest
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING id`);
		this.#insertQuestion = db.prepare(
			"INSERT INTO questions (decision, ordinal, name, type, instructions, criteria) VALUES (?, ?, ?, ?, ?, ?)",
		);
		this.#insertAnswer = db.prepare(
			"INSERT INTO answers (decision, ordinal, question, type, value, probabilities, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		this.#insertState = db.prepare("INSERT OR IGNORE INTO states (digest, state, created_at) VALUES (?, ?, ?)");
	}

	/**
	 * Open (creating if needed) the ledger at `dbPath`, quarantining a corrupt store once.
	 * @throws when the directory or database cannot be created.
	 */
	static open(dbPath: string = getDecisionsDbPath()): DecisionLedger {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		return openSqliteDatabaseSync(dbPath, db => new DecisionLedger(db), { recoverCorruption: true });
	}

	/**
	 * Record one decision and return its row id.
	 *
	 * Best-effort: a failure is logged and reported as `undefined`, so a caller
	 * can await the write for ordering without ever failing a turn over it.
	 */
	append(event: DecisionEvent): number | undefined {
		try {
			return this.#db.transaction(() => {
				if (event.stateDigest !== undefined && event.state !== undefined) {
					this.#insertState.run(event.stateDigest, JSON.stringify(event.state), Math.floor(event.at / 1000));
				}
				const row = this.#insertDecision.get(
					event.sessionId ?? null,
					event.at,
					event.point,
					event.action,
					event.tier,
					event.risk ?? null,
					event.confidence ?? null,
					event.model,
					event.api,
					event.provider,
					event.reason ?? null,
					event.conflict ?? null,
					event.elapsedMs ?? null,
					event.cost ?? 0,
					event.inputTokens ?? 0,
					event.cached ? 1 : 0,
					event.cachedQuestions ?? null,
					event.batchId ?? null,
					event.stateDigest ?? null,
				);
				if (!row) return undefined;
				event.questions.forEach((question, index) => {
					this.#insertQuestion.run(
						row.id,
						index,
						question.id,
						question.type,
						question.instructions,
						question.criteria === undefined ? null : JSON.stringify(question.criteria),
					);
				});
				event.answers.forEach((answer, index) => {
					this.#insertAnswer.run(
						row.id,
						index,
						answer.question,
						answer.type,
						String(answer.value),
						answer.probabilities === undefined ? null : JSON.stringify(answer.probabilities),
						answer.confidence ?? null,
					);
				});
				return row.id;
			})();
		} catch (error) {
			logger.warn("decision ledger write failed", { error: String(error), point: event.point });
			return undefined;
		}
	}

	/** Record many decisions in one transaction; returns the ids that were written. */
	appendAll(events: readonly DecisionEvent[]): number[] {
		const ids: number[] = [];
		for (const event of events) {
			const id = this.append(event);
			if (id !== undefined) ids.push(id);
		}
		return ids;
	}

	/** Decisions matching `filter`, newest first. */
	list(filter: DecisionFilter = {}): DecisionEvent[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (filter.session !== undefined) {
			where.push("session = ?");
			params.push(filter.session);
		}
		if (filter.points?.length) {
			where.push(`point IN (${filter.points.map(() => "?").join(",")})`);
			params.push(...filter.points);
		}
		if (filter.actions?.length) {
			where.push(`action IN (${filter.actions.map(() => "?").join(",")})`);
			params.push(...filter.actions);
		}
		if (filter.tiers?.length) {
			where.push(`tier IN (${filter.tiers.map(() => "?").join(",")})`);
			params.push(...filter.tiers);
		}
		if (filter.since !== undefined) {
			where.push("at >= ?");
			params.push(filter.since);
		}
		if (filter.conflictsOnly) where.push("conflict IS NOT NULL");
		const limit = Math.max(1, Math.min(filter.limit ?? 100, 10_000));
		const offset = Math.max(0, filter.offset ?? 0);
		const sql = `SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ? OFFSET ?`;
		try {
			const rows = this.#db.query(sql).all(...params, limit, offset) as DecisionRow[];
			return rows.map(row => this.#hydrate(row));
		} catch (error) {
			logger.warn("decision ledger read failed", { error: String(error) });
			return [];
		}
	}

	/** One decision by row id, with its state attached. */
	get(id: number): DecisionEvent | undefined {
		try {
			const row = this.#db.query("SELECT * FROM decisions WHERE id = ?").get(id) as DecisionRow | null;
			if (!row) return undefined;
			const event = this.#hydrate(row);
			if (row.state_digest) {
				const state = this.#db.query("SELECT state FROM states WHERE digest = ?").get(row.state_digest) as {
					state: string;
				} | null;
				if (state) event.state = JSON.parse(state.state);
			}
			return event;
		} catch (error) {
			logger.warn("decision ledger detail read failed", { error: String(error), id });
			return undefined;
		}
	}

	/** Session totals, from the same filter the list uses. */
	totals(filter: DecisionFilter = {}): DecisionTotals {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (filter.session !== undefined) {
			where.push("session = ?");
			params.push(filter.session);
		}
		if (filter.since !== undefined) {
			where.push("at >= ?");
			params.push(filter.since);
		}
		const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
		try {
			const row = this.#db
				.query(
					`SELECT COUNT(*) AS count,
						COALESCE(SUM(cost), 0) AS cost,
						COALESCE(SUM(elapsed_ms), 0) AS elapsed,
						COALESCE(SUM(input_tokens), 0) AS tokens,
						COALESCE(SUM(CASE WHEN action = 'gated' THEN 1 ELSE 0 END), 0) AS gated,
						COALESCE(SUM(CASE WHEN conflict IS NOT NULL THEN 1 ELSE 0 END), 0) AS conflicts,
						COALESCE(SUM(cached), 0) AS cached
					FROM decisions ${clause}`,
				)
				.get(...params) as {
				count: number;
				cost: number;
				elapsed: number;
				tokens: number;
				gated: number;
				conflicts: number;
				cached: number;
			};
			return {
				count: row.count,
				cost: row.cost,
				elapsedMs: row.elapsed,
				inputTokens: row.tokens,
				gated: row.gated,
				conflicts: row.conflicts,
				cached: row.cached,
			};
		} catch (error) {
			logger.warn("decision ledger totals failed", { error: String(error) });
			return { count: 0, cost: 0, elapsedMs: 0, inputTokens: 0, gated: 0, conflicts: 0, cached: 0 };
		}
	}

	/** Per-point aggregates, most active first. */
	points(filter: DecisionFilter = {}): DecisionPointSummary[] {
		const params: (string | number)[] = [];
		let clause = "";
		if (filter.session !== undefined) {
			clause = "WHERE session = ?";
			params.push(filter.session);
		}
		try {
			const rows = this.#db
				.query(
					`SELECT point,
						COUNT(*) AS count,
						COALESCE(SUM(cost), 0) AS cost,
						COALESCE(SUM(elapsed_ms), 0) AS elapsed,
						AVG(confidence) AS confidence,
						COALESCE(SUM(CASE WHEN action = 'gated' THEN 1 ELSE 0 END), 0) AS gated
					FROM decisions ${clause}
					GROUP BY point
					ORDER BY count DESC`,
				)
				.all(...params) as {
				point: string;
				count: number;
				cost: number;
				elapsed: number;
				confidence: number | null;
				gated: number;
			}[];
			return rows.map(row => ({
				point: row.point,
				count: row.count,
				cost: row.cost,
				elapsedMs: row.elapsed,
				meanConfidence: row.confidence ?? undefined,
				gated: row.gated,
			}));
		} catch (error) {
			logger.warn("decision ledger point summary failed", { error: String(error) });
			return [];
		}
	}

	/** Checkpoint and close the database; the ledger must not be used afterwards. */
	close(): void {
		checkpointWal(this.#db);
		this.#db.close();
	}

	#hydrate(row: DecisionRow): DecisionEvent {
		const questions = this.#db
			.query("SELECT * FROM questions WHERE decision = ? ORDER BY ordinal")
			.all(row.id) as QuestionRow[];
		const answers = this.#db
			.query("SELECT * FROM answers WHERE decision = ? ORDER BY ordinal")
			.all(row.id) as AnswerRow[];
		const event: DecisionEvent = {
			id: row.id,
			at: row.at,
			point: row.point,
			action: row.action as DecisionEvent["action"],
			tier: row.tier as DecisionEvent["tier"],
			model: row.model,
			api: row.api,
			provider: row.provider,
			questions: questions.map(question => {
				const record: DecisionQuestionRecord = {
					id: question.name,
					type: question.type as DecisionQuestionRecord["type"],
					instructions: question.instructions,
				};
				if (question.criteria) record.criteria = JSON.parse(question.criteria);
				return record;
			}),
			answers: answers.map(answer => {
				const record: DecisionAnswerRecord = {
					question: answer.question,
					type: answer.type as DecisionAnswerRecord["type"],
					value: coerceValue(answer.value, answer.type),
				};
				if (answer.probabilities) record.probabilities = JSON.parse(answer.probabilities);
				if (answer.confidence !== null) record.confidence = answer.confidence;
				return record;
			}),
			cost: row.cost,
			inputTokens: row.input_tokens,
		};
		if (row.session) event.sessionId = row.session;
		if (row.risk) event.risk = row.risk as DecisionEvent["risk"];
		if (row.confidence !== null) event.confidence = row.confidence;
		if (row.reason) event.reason = row.reason;
		if (row.conflict) event.conflict = row.conflict;
		if (row.elapsed_ms !== null) event.elapsedMs = row.elapsed_ms;
		if (row.cached_questions !== null) event.cachedQuestions = row.cached_questions;
		if (row.batch) event.batchId = row.batch;
		if (row.state_digest) event.stateDigest = row.state_digest;
		event.cached = row.cached === 1;
		return event;
	}
}

interface DecisionRow {
	id: number;
	session: string | null;
	at: number;
	point: string;
	action: string;
	tier: string;
	risk: string | null;
	confidence: number | null;
	model: string;
	api: string;
	provider: string;
	reason: string | null;
	conflict: string | null;
	elapsed_ms: number | null;
	cost: number;
	input_tokens: number;
	cached: number;
	cached_questions: number | null;
	batch: string | null;
	state_digest: string | null;
}

interface QuestionRow {
	name: string;
	type: string;
	instructions: string;
	criteria: string | null;
}

interface AnswerRow {
	question: string;
	type: string;
	value: string;
	probabilities: string | null;
	confidence: number | null;
}

/** Numeric answer values were stored as text; restore the number a caller can compare. */
function coerceValue(value: string, type: string): string | number {
	if (type === "choice" || type === "box") return value;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : value;
}
