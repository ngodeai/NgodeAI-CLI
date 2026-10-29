/**
 * Contract: the anchored subagent HUD renders a single compact shimmering line
 * "Sub Agents · N running [Alt+A to open]" where N dynamically reflects the number
 * of running subagents without any multi-line listing of subagent names, and yields
 * no output once nothing qualifies, so the block self-clears.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@ngodeai/agent-core";
import { ModelRegistry } from "@ngodeai/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@ngodeai/coding-agent/config/settings";
import { resetHangulCompatibilityJamoWidthForTests, setHangulCompatibilityJamoWidth } from "@ngodeai/tui";
import { PINNED_HUD_TOGGLE_ID } from "@ngodeai/tui/prompt/composer";
import {
	InteractiveMode,
	layoutPinnedHud,
	nextSubagentPreviewTickMs,
	renderSubagentHudLines,
	SubagentHudComponent,
} from "@ngodeai/coding-agent/modes/interactive-mode";
import { type ObservableSession, SessionObserverRegistry } from "@ngodeai/tui/overlays/session-observer-registry";
import { initTheme } from "@ngodeai/tui/theme";
import { AgentSession } from "@ngodeai/coding-agent/session/agent-session";
import { AuthStorage } from "@ngodeai/coding-agent/session/auth-storage";
import { SessionManager } from "@ngodeai/coding-agent/session/session-manager";
import { type AgentProgress } from "@ngodeai/tui/tools/task";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@ngodeai/coding-agent/task";
import { EventBus } from "@ngodeai/coding-agent/utils/event-bus";
import { TempDir } from "@ngodeai/utils";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

function render(sessions: ObservableSession[], columns = 120, livePreview = false): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns, false, livePreview).join("\n"));
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders exactly 1 line with Sub Agents · 1 running [Alt+A to open] when 1 agent is active", () => {
		const out = render([makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" })]);
		expect(out).toBe("Sub Agents · 1 running [Alt+A to open]");
	});

	it("dynamically adapts the count parameter to the number of running subagents", () => {
		const twoAgents = render([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(twoAgents).toBe("Sub Agents · 2 running [Alt+A to open]");

		const fiveAgents = Array.from({ length: 5 }, (_, i) =>
			makeSession({ id: `Worker${i}`, description: `Task ${i}` }),
		);
		expect(render(fiveAgents)).toBe("Sub Agents · 5 running [Alt+A to open]");

		const tenAgents = Array.from({ length: 10 }, (_, i) =>
			makeSession({ id: `Worker${i}`, description: `Task ${i}` }),
		);
		expect(render(tenAgents)).toBe("Sub Agents · 10 running [Alt+A to open]");
	});

	it("does not list subagent names or task details in the HUD", () => {
		const out = render([
			makeSession({ id: "SecretAgent", description: "Classified task description" }),
			makeSession({ id: "AnotherAgent", description: "Another hidden detail" }),
		]);
		expect(out).not.toContain("SecretAgent");
		expect(out).not.toContain("Classified task description");
		expect(out).not.toContain("AnotherAgent");
		expect(out).not.toContain("Another hidden detail");
		expect(out).toBe("Sub Agents · 2 running [Alt+A to open]");
	});

	it("uses custom hubKey when specified", () => {
		const raw = renderSubagentHudLines([makeSession({ id: "Worker" })], 120, false, false, "Ctrl+A");
		expect(Bun.stripANSI(raw[0]!)).toBe("Sub Agents · 1 running [Ctrl+A to open]");
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expect(out).toBe("Sub Agents · 1 running [Alt+A to open]");
	});

	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = render(registry.getSessions());
		expect(out).toBe("Sub Agents · 3 running [Alt+A to open]");
	});

	it("dedupes frames dual-published on the session bus and the shared bus", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const kinds: string[] = [];
		registry.onChange(kind => kinds.push(kind));
		const payload = makeLifecycle("DualPublished", 0, "dual-published frame");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		expect(kinds).toEqual(["lifecycle"]);
		expect(registry.getActiveSubagentCount()).toBe(1);
		registry.dispose();
	});

	it("keeps subagent registry order stable while progress arrives out of order", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const activeIds = () =>
			registry
				.getSessions()
				.filter(session => session.kind === "subagent" && session.status === "active")
				.map(session => session.id);

		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("SelectorSurfaces", 0, "Map selector surfaces"));
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);
	});

	it("fits within the padded HUD width without wrapping to multiple rows", () => {
		const sessions = [makeSession({ id: "Worker" })];
		for (const columns of [40, 60, 120]) {
			const hud = new SubagentHudComponent(renderSubagentHudLines(sessions, columns), ["Worker"]);
			const rendered = hud.render(columns);
			expect(rendered).toHaveLength(1);
			expect(Bun.stringWidth(rendered[0]!)).toBeLessThanOrEqual(columns);
		}
	});

	it("arms the repaint for when the elapsed marker first shows, then every second", () => {
		const now = 100_000;
		const midCall = (id: string, startMs: number) =>
			makeSession({ id, progress: makeProgress({ id, currentTool: "bash", currentToolStartMs: startMs }) });
		const thinking = makeSession({ id: "Thinking", progress: makeProgress({ id: "Thinking" }) });
		expect(nextSubagentPreviewTickMs([thinking], now)).toBeUndefined();
		expect(nextSubagentPreviewTickMs([midCall("Fresh", now - 1_000)], now)).toBe(4_001);
		expect(nextSubagentPreviewTickMs([midCall("Long", now - 30_000)], now)).toBe(1_000);
		expect(
			nextSubagentPreviewTickMs([thinking, midCall("Fresh", now - 4_500), midCall("Long", now - 30_000)], now),
		).toBe(501);
	});
});

describe("SubagentHudComponent click rows", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("maps single-line HUD row 0 to the first running agent id", () => {
		const lines = renderSubagentHudLines([makeSession({ id: "Alpha" }), makeSession({ id: "Beta" })], 120);
		const hud = new SubagentHudComponent(lines, ["Alpha", "Beta"]);

		const rendered = hud.render(120);
		expect(rendered).toHaveLength(1);
		expect(hud.getClickAgentAtRow(0)).toBe("Alpha");
		expect(hud.getClickAgentAtRow(1)).toBeUndefined();
		expect(hud.getClickAgentAtRow(-1)).toBeUndefined();
	});

	it("resolves the expander row to the toggle sentinel", () => {
		const hud = new SubagentHudComponent(["", "Subagents", "row", "toggle"], ["Only"], 3);
		hud.render(120);
		expect(hud.getClickAgentAtRow(3)).toBe(PINNED_HUD_TOGGLE_ID);
		expect(hud.getClickAgentAtRow(2)).toBe("Only");
	});

	it("maps wrapped continuation rows to the agent that started them", () => {
		const long = ` ${"x".repeat(200)}`;
		const hud = new SubagentHudComponent(["", "Subagents", long, "short"], ["Long", "Short"]);
		const rendered = hud.render(40);
		expect(rendered.length).toBeGreaterThan(4);
		const shortRow = rendered.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(shortRow).toBeGreaterThan(3);
		expect(hud.getClickAgentAtRow(2)).toBe("Long");
		expect(hud.getClickAgentAtRow(3)).toBe("Long");
		expect(hud.getClickAgentAtRow(shortRow)).toBe("Short");
		expect(hud.getClickAgentAtRow(shortRow + 1)).toBeUndefined();
	});

	it("maps clicks after wrapping and resizing while leaving clicks before rendering unmapped", () => {
		const hud = new SubagentHudComponent(["", "Subagents", ` ${"x".repeat(100)}`, "short"], ["Long", "Short"]);
		expect(hud.getClickAgentAtRow(2)).toBeUndefined();

		const narrowRows = hud.render(40);
		const narrowShortRow = narrowRows.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(narrowShortRow).toBeGreaterThan(3);
		expect(hud.getClickAgentAtRow(narrowShortRow - 1)).toBe("Long");
		expect(hud.getClickAgentAtRow(narrowShortRow)).toBe("Short");

		const wideRows = hud.render(120);
		expect(wideRows.length).toBeLessThan(narrowRows.length);
		const wideShortRow = wideRows.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(hud.getClickAgentAtRow(wideShortRow)).toBe("Short");
		expect(hud.getClickAgentAtRow(wideShortRow + 1)).toBeUndefined();
	});

	it("remaps clicks when runtime character width changes", () => {
		setHangulCompatibilityJamoWidth(1);
		try {
			const hud = new SubagentHudComponent(["", "Subagents", ` ${"ㅁ".repeat(25)}`, "next"], ["Jamo", "Next"]);
			const narrowRows = hud.render(40);
			const narrowNextRow = narrowRows.findIndex(line => Bun.stripANSI(line).includes("next"));
			expect(hud.getClickAgentAtRow(narrowNextRow)).toBe("Next");

			setHangulCompatibilityJamoWidth(2);
			expect(hud.getClickAgentAtRow(narrowNextRow)).toBe("Next");
			const wideRows = hud.render(40);
			const wideNextRow = wideRows.findIndex(line => Bun.stripANSI(line).includes("next"));
			expect(wideNextRow).toBeGreaterThan(narrowNextRow);
			expect(hud.getClickAgentAtRow(wideNextRow - 1)).toBe("Jamo");
			expect(hud.getClickAgentAtRow(wideNextRow)).toBe("Next");
		} finally {
			resetHangulCompatibilityJamoWidthForTests();
		}
	});
});

describe("layoutPinnedHud", () => {
	it("fits small lists without an expander", () => {
		expect(layoutPinnedHud(0, false)).toEqual({ itemRows: 0, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, false)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, true)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
	});

	it("collapses longer lists behind an expander", () => {
		expect(layoutPinnedHud(4, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
		expect(layoutPinnedHud(10, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
	});

	it("expands to every row with a collapse row", () => {
		expect(layoutPinnedHud(5, true)).toEqual({ itemRows: 5, toggle: "collapse", toggleRow: 7 });
		expect(layoutPinnedHud(10, true)).toEqual({ itemRows: 10, toggle: "collapse", toggleRow: 12 });
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		setSystemTime();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("coalesces a burst of progress observer changes into one HUD rebuild and render request", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const mountHud = vi.spyOn(mode.subagentContainer, "addChild");
		const updateHud = vi.spyOn(SubagentHudComponent.prototype, "update");
		vi.useFakeTimers();

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		vi.runAllTimers();
		await Promise.resolve();

		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("Sub Agents · 6 running [Alt+A to open]");
		expect(mountHud.mock.calls.length + updateHud.mock.calls.length).toBe(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("renders 1-line HUD with accurate count on multiple lifecycle events", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		for (let index = 0; index < 5; index++) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(`Override${index}`, index, `job ${index}`));
		}
		await Bun.sleep(150);
		const hudText = () => Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hudText()).toContain("Sub Agents · 5 running [Alt+A to open]");
	});

	it("keeps the 1-line HUD mounted and repaints in place across progress updates", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		setSystemTime(1_000_000);
		const payload = makeProgressPayload("Sleeper", 0, "Run sleep", true);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		const hudText = () => Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		const hud = mode.subagentContainer.children[0];
		expect(hudText()).toContain("Sub Agents · 1 running [Alt+A to open]");

		vi.advanceTimersByTime(1_000);
		expect(mode.subagentContainer.children[0]).toBe(hud);
		expect(hudText()).toContain("Sub Agents · 1 running [Alt+A to open]");
	});
});
