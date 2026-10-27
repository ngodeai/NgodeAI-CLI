/**
 * Auto-learn session controller (experimental).
 *
 * Subscribes to the session event stream and, after a substantive turn,
 * optionally auto-runs a synthetic capture turn. Passive mode is intentionally
 * prompt-cache neutral: the standing system guidance remains available, but no
 * hidden mid-session reminder is inserted into the conversation.
 *
 * Installed once per top-level session (taskDepth 0) regardless of
 * `autolearn.enabled`: every stop re-reads the live setting, so toggling it
 * mid-session takes effect at the next stop. The subscription lives for the
 * session's lifetime — `newSession` resets the session in place without
 * re-running startup — so the controller needs no disposal.
 */
import { judgeQuestions } from "@ngodeai/ai";
import type { ChainJudge } from "../judgment";
import { logger } from "@ngodeai/utils";
import type { Settings } from "../config/settings";
import autolearnGuidance from "../prompts/system/autolearn-guidance.md" with { type: "text" };
import autolearnGuidanceLearn from "../prompts/system/autolearn-guidance-learn.md" with { type: "text" };
import autolearnNudgeAutoContinue from "../prompts/system/autolearn-nudge-autocontinue.md" with { type: "text" };
import autolearnQuestions from "../prompts/judge/autolearn.json" with { type: "json" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

import { cfgAutolearnAutoContinue, cfgAutolearnEnabled, cfgAutolearnMinToolCalls } from "./settings";

const AUTOLEARN_NUDGE_AUTOCONTINUE = autolearnNudgeAutoContinue.trim();

/** The keep-or-not ladder, derived from its JSON file like every other judge question. */
const AUTOLEARN_QUESTIONS = judgeQuestions(autolearnQuestions);

/** Probability of `nothing` at or above which a capture turn is not worth running. */
const AUTOLEARN_SKIP_AT = 0.6;

/** Leading characters of each turn message the gate reads. */
const AUTOLEARN_MESSAGE_CHARS = 1_200;

/**
 * Build the standing auto-learn guidance for the system prompt from the tools
 * actually present in the active set, or null when `manage_skill` is absent.
 *
 * Driven by tool presence rather than settings: keying the guidance on
 * `autolearn.enabled` would let a subagent that filtered the tools out — or a
 * session whose registry has not yet reconciled — inject guidance pointing at
 * tools the session does not have. The `learn` addendum is included only when
 * the `learn` tool is present (it requires a memory backend).
 */
export function buildAutoLearnInstructions(available: { manageSkill: boolean; learn: boolean }): string | null {
	if (!available.manageSkill) return null;
	const parts = [autolearnGuidance.trim()];
	if (available.learn) parts.push(autolearnGuidanceLearn.trim());
	return parts.join("\n\n");
}

export interface AutoLearnControllerOptions {
	session: AgentSession;
	settings: Settings;
	capture: (content: string) => Promise<void>;
}

export class AutoLearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #capture: (content: string) => Promise<void>;
	#toolCalls = 0;
	/**
	 * Whether the in-flight turn BEGAN while goal mode was active. Captured at
	 * agent_start because a `goal` tool can complete or drop the goal mid-turn,
	 * clearing the live flag before agent_end — so the end-of-turn state alone
	 * would let a goal-continuation turn slip through and get nudged.
	 */
	#turnStartedInGoalMode = false;
	/** Prevent overlapping private capture runs while real primary turns continue. */
	#captureInFlight = false;
	/** One newer eligible primary stop arrived while capture was running. */
	#capturePending = false;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#capture = options.capture;
		// The listener closure captures `this`, so the session's listener array
		// keeps the controller alive — no stored unsubscribe needed.
		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			// Capture goal-mode state at the turn boundary, before any tool runs.
			this.#turnStartedInGoalMode = this.#session.getGoalModeState()?.enabled === true;
			return;
		}
		if (event.type === "tool_execution_end") {
			this.#toolCalls++;
			return;
		}
		if (event.type === "agent_end") {
			this.#onAgentEnd(event);
		}
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// Snapshot and reset every turn: the counter describes only the
		// just-finished turn, so below-threshold, disabled, and plan-mode stops
		// must not let tool calls accumulate into a later turn.
		const toolCalls = this.#toolCalls;
		this.#toolCalls = 0;
		// Snapshot the turn-start goal flag alongside the counter so a turn that
		// observed no agent_start can never inherit a stale value.
		const startedInGoalMode = this.#turnStartedInGoalMode;
		this.#turnStartedInGoalMode = false;

		// Never nudge a turn that ended in an abort (ESC, cancel, etc.). The
		// abort flag on the session is unreliable by the time agent_end is
		// deferred to subscribers; read stopReason from the event messages.
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				if ("stopReason" in message && message.stopReason === "aborted") {
					return;
				}
				break;
			}
		}
		// The controller is installed regardless of the flag; honor its live value.
		if (!cfgAutolearnEnabled.get(this.#settings)) return;
		const minToolCalls = cfgAutolearnMinToolCalls.get(this.#settings);
		if (toolCalls < minToolCalls) return;
		// Never interrupt plan-mode review.
		if (this.#session.getPlanModeState()?.enabled) return;
		// Never divert a goal loop. Skip when the turn STARTED in goal mode — a
		// `goal` tool may have completed/dropped the goal before this stop — or is
		// still in it: a passive nudge would ride the goal continuation, and
		// auto-continue would compete with it.
		if (startedInGoalMode || this.#session.getGoalModeState()?.enabled) return;

		// Auto-run a capture turn only when explicitly enabled. Passive mode used to
		// queue a hidden custom message for the next real turn, but that mutates the
		// persisted conversation prefix after providers have cached it. The standing
		// auto-learn system guidance is stable; keep passive mode to that guidance
		// so Anthropic prompt-cache prefixes survive long sessions.
		const autoContinue = cfgAutolearnAutoContinue.get(this.#settings) === true;
		if (!autoContinue) return;

		if (this.#captureInFlight) {
			this.#capturePending = true;
			return;
		}
		// A capture turn is a whole agent turn. When a judge is available, ask it
		// whether there is anything to keep before paying for one: most
		// substantive turns have nothing generalizable, and the gate is a single
		// cheap request. Without a judge the path stays synchronous, so a session
		// that never configured one behaves exactly as it did before.
		const judge = this.#session.decisionJudge?.("autolearn");
		if (!judge) {
			this.#startCapture();
			return;
		}
		void this.#worthCapturing(event.messages, judge)
			.then(worth => {
				if (!worth) return;
				this.#startCapture();
			})
			.catch(error => logger.warn("auto-learn gate failed", { error: String(error) }));
	}

	/**
	 * Whether this turn holds something worth a capture turn.
	 *
	 * Fails open: a judge that cannot answer leaves the existing behavior
	 * untouched, because a missing gate must not silently disable a feature the
	 * user turned on. The decision is recorded either way, so a session that
	 * skipped twenty captures can show why.
	 */
	async #worthCapturing(messages: readonly unknown[], judge: ChainJudge): Promise<boolean> {
		const transcript = messages
			.map(message => {
				if (typeof message !== "object" || message === null) return "";
				const typed = message as { role?: string; content?: unknown };
				const content = typed.content;
				const text =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.map((block: unknown) => {
										if (typeof block !== "object" || block === null) return "";
										const part = block as { type?: string; text?: string; name?: string };
										if (part.type === "text") return part.text ?? "";
										if (part.type === "toolCall") return `[tool ${part.name ?? "?"}]`;
										return "";
									})
									.filter(Boolean)
									.join(" ")
							: "";
				return text ? `${typed.role ?? "?"}: ${text.slice(0, AUTOLEARN_MESSAGE_CHARS)}` : "";
			})
			.filter(Boolean)
			.join("\n\n")
			.slice(0, 16_000);
		if (!transcript.trim()) return true;

		const decision = this.#session.decisions.open("autolearn", { risk: "read", decisionKeys: ["worth"] });
		try {
			const { answers } = await judge.judge(
				{ state: { turn: transcript }, questions: { worth: AUTOLEARN_QUESTIONS.worth } },
				{ decision },
			);
			const nothing = answers.worth.probabilities.nothing ?? 0;
			const keep = 1 - nothing;
			// The point's `read` matrix decides whether a confident "keep" is
			// enough to spend a whole capture turn. Its own skip threshold still
			// applies, so a gate can only ever make the capture *less* likely:
			// spending a turn on a doubtful answer is the expensive mistake.
			const gate = this.#session.decisions.gate("autolearn", keep, "read");
			const worth = nothing < AUTOLEARN_SKIP_AT && gate.verdict !== "block";
			decision.settle({
				action: worth ? "auto" : "skipped",
				tier: worth ? "line" : "silent",
				reason: worth
					? `worth keeping (${answers.worth.choice}) · ${keep.toFixed(2)}`
					: gate.verdict === "block"
						? `too unsure to spend a capture turn · ${gate.reason}`
						: `nothing to keep · ${nothing.toFixed(2)}`,
			});
			return worth;
		} catch (error) {
			decision.fail(error);
			return true;
		}
	}

	#startCapture(): void {
		this.#captureInFlight = true;
		void this.#capture(AUTOLEARN_NUDGE_AUTOCONTINUE)
			.catch(err => {
				logger.warn("auto-learn capture failed", { err });
			})
			.finally(() => {
				this.#captureInFlight = false;
				if (!this.#capturePending) return;
				this.#capturePending = false;
				this.#startCapture();
			});
	}
}
