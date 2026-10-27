import { beforeAll, describe, expect, it } from "bun:test";
import {
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	SIDEBAR_SPLIT_AT,
	StatusSidebar,
	clampSidebarWidth,
} from "../src/components/sidebar";
import { initTheme } from "../src/theme/theme";
import { visibleWidth } from "../src/utils";

beforeAll(async () => {
	await initTheme();
});

/** Strip SGR so widths can be measured. */
const plain = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row));

const fullState = {
	tasks: [
		{
			name: "Setup",
			tasks: [
				{ content: "Scaffold the component", status: "completed" as const },
				{ content: "Wire it into the composer layout", status: "in_progress" as const },
				{ content: "Add the settings toggle", status: "pending" as const },
			],
		},
	],
	context: { usedTokens: 84_000, maxTokens: 200_000 },
	git: { branch: "main", added: 3, modified: 2 },
	model: { selector: "ngodeai/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
};

describe("StatusSidebar", () => {
	it("renders every section it is given", () => {
		const sidebar = new StatusSidebar();
		sidebar.setState(fullState);
		const text = plain(sidebar.render(32)).join("\n");

		expect(text).toContain("TASKS");
		expect(text).toContain("Scaffold the component");
		expect(text).toContain("CONTEXT");
		expect(text).toContain("42%");
		expect(text).toContain("GIT");
		expect(text).toContain("main");
		expect(text).toContain("MODEL");
		expect(text).toContain("Claude Sonnet 4.5");
	});

	it("renders decision model section when present", () => {
		const sidebar = new StatusSidebar();
		sidebar.setState({
			...fullState,
			decisionModel: { selector: "ngodeai/mercury-decide", displayName: "mercury-decide", effort: "native" },
		});
		const text = plain(sidebar.render(32)).join("\n");
		expect(text).toContain("DECISION MODEL");
		expect(text).toContain("mercury-decide");
		expect(text).toContain("native");
	});

	/**
	 * The sidebar shares the screen with the transcript, so a row one cell too
	 * wide wraps in the terminal and shears the whole frame.
	 */
	it("frames every row to exactly the pane width", () => {
		for (const width of [SIDEBAR_MIN_WIDTH, 26, 32, SIDEBAR_MAX_WIDTH]) {
			const sidebar = new StatusSidebar();
			sidebar.setState(fullState);
			const rows = plain(sidebar.render(width));
			expect(rows.length).toBeGreaterThan(2);
			for (const row of rows) expect(visibleWidth(row)).toBe(width);
			// Square-dot rules top and bottom, vertical rules on every content row.
			expect(rows[0]?.startsWith("▪")).toBe(true);
			expect(rows[0]?.endsWith("▪")).toBe(true);
			expect(rows.at(-1)?.startsWith("▪")).toBe(true);
			for (const row of rows.slice(1, -1)) {
				expect(row.startsWith("│")).toBe(true);
				expect(row.endsWith("│")).toBe(true);
			}
		}
	});

	it("renders the session, agents, and usage sections", () => {
		const sidebar = new StatusSidebar();
		sidebar.setState({
			...fullState,
			usage: {
				inputTokens: 12_400,
				outputTokens: 3_100,
				tokensPerSecond: 48,
				cost: 0.42,
				elapsedMs: 754_000,
				cacheHitRate: 0.63,
			},
			agents: { running: 2, total: 5 },
		});
		const text = plain(sidebar.render(36)).join("\n");

		expect(text).toContain("SESSION");
		expect(text).toContain("12k in · 3k out");
		expect(text).toContain("48 t/s");
		expect(text).toContain("$0.42");
		expect(text).toContain("cache 63%");
		expect(text).toContain("AGENTS");
		expect(text).toContain("2 running · 5 total");
	});

	/** The roster lists each agent with its state, model, and spend. */
	it("renders the agent roster, not just a count", () => {
		const sidebar = new StatusSidebar();
		sidebar.setState({
			...fullState,
			agents: {
				running: 1,
				total: 2,
				list: [
					{
						id: "a",
						name: "SmokeScout",
						status: "running",
						kind: "reviewer",
						model: "ngodeai/deepseek-v4.1-flash-1017",
						durationMs: 35_700,
						tokens: 136_000,
						cost: 0.003,
					},
					{
						id: "b",
						name: "SmokeTask",
						status: "idle",
						kind: "task",
						durationMs: 4_100,
						tokens: 10_000,
						cost: 0.0002,
					},
				],
			},
		});
		const text = plain(sidebar.render(34)).join("\n");

		expect(text).toContain("AGENTS");
		expect(text).toContain("1 running · 2 total");
		expect(text).toContain("SmokeScout");
		expect(text).toContain("reviewer");
		expect(text).toContain("SmokeTask");
		// Sub-cent spend keeps its significant digits instead of collapsing to
		// "<$0.01", which made a cheap agent and a nearly-free one identical.
		expect(text).toContain("$0.003");
		expect(text).toContain("$0.0002");
		expect(text).toContain("36s");
		expect(text).toContain("136k tok");
	});

	/** Running agents sort ahead of finished ones: they are what the user can act on. */
	it("keeps the roster inside the pane at every width", () => {
		for (const width of [SIDEBAR_MIN_WIDTH, 30, SIDEBAR_MAX_WIDTH]) {
			const sidebar = new StatusSidebar();
			sidebar.setState({
				...fullState,
				agents: {
					running: 1,
					total: 1,
					list: [
						{
							id: "a",
							name: "AVeryLongAgentNameThatNeedsWrapping",
							status: "running",
							kind: "reviewer",
							model: "ngodeai/deepseek-v4.1-flash-1017-with-a-long-tail",
							durationMs: 3_600_000,
							tokens: 1_500_000,
							cost: 12.3456,
						},
					],
				},
			});
			for (const row of plain(sidebar.render(width))) {
				expect(visibleWidth(row)).toBe(width);
			}
		}
	});

	/**
	 * An idle roster keeps its section with an explicit "No agents running".
	 * Hiding it made the pane's height jump whenever the last agent finished.
	 */
	it("keeps the agents section visible when nothing is running", () => {
		const sidebar = new StatusSidebar();
		sidebar.setState({ ...fullState, agents: { running: 0 } });
		const text = plain(sidebar.render(32)).join("\n");
		expect(text).toContain("AGENTS");
		expect(text).toContain("No agents running");
	});

	/** No agents object at all means the host does not track them: no section. */
	it("omits the agents section when the host tracks no agents", () => {
		const sidebar = new StatusSidebar();
		sidebar.setState(fullState);
		expect(plain(sidebar.render(32)).join("\n")).not.toContain("AGENTS");
	});

	/**
	 * A long plan must not push the lower sections out of the pane. The plan is
	 * the one unbounded section, so it is the one that yields.
	 */
	it("keeps every lower section visible when the plan is long", () => {
		const longPlan = Array.from({ length: 6 }, (_, phase) => ({
			name: `phase ${phase + 1}`,
			tasks: Array.from({ length: 4 }, (_, task) => ({
				content: `Task ${task + 1} in phase ${phase + 1} with a long description that wraps around`,
				status: "pending" as const,
			})),
		}));
		for (const height of [22, 30, 40]) {
			const sidebar = new StatusSidebar();
			sidebar.setState({
				tasks: longPlan,
				context: { usedTokens: 22_000, maxTokens: 1_000_000, percent: 2 },
				usage: { inputTokens: 91_000, outputTokens: 3_000, cost: 0.0021, elapsedMs: 44_000 },
				git: { branch: "main" },
				model: { selector: "ngodeai/deepseek", displayName: "DeepSeek V4.1" },
				agents: { running: 0, total: 0, list: [] },
			});
			sidebar.setHeight(height);
			const rows = plain(sidebar.render(38));
			const text = rows.join("\n");

			expect(rows.length).toBe(height);
			for (const section of ["TASKS", "CONTEXT", "SESSION", "GIT", "MODEL", "AGENTS"]) {
				expect(text).toContain(section);
			}
			// The cut is announced, not silent.
			expect(text).toContain("more");
		}
	});

	/** A short plan is never trimmed. */
	it("does not trim a plan that fits", () => {
		const sidebar = new StatusSidebar();
		sidebar.setState(fullState);
		sidebar.setHeight(40);
		const text = plain(sidebar.render(38)).join("\n");
		expect(text).not.toContain("more");
		expect(text).toContain("Scaffold the component");
	});

	/** The frame is part of the layout, so an empty pane still draws it. */
	it("draws the frame even with no state", () => {
		const sidebar = new StatusSidebar();
		const rows = plain(sidebar.render(24));
		expect(rows.length).toBe(2);
		expect(rows[0]?.startsWith("▪")).toBe(true);
	});

	/** A task label longer than the pane wraps under its own glyph, not as a new item. */
	it("wraps a long task under the glyph column", () => {
		const sidebar = new StatusSidebar();
		sidebar.setState({
			tasks: [
				{
					name: "",
					tasks: [{ content: "A task description long enough to need wrapping at this width", status: "pending" }],
				},
			],
		});
		const rows = plain(sidebar.render(SIDEBAR_MIN_WIDTH));
		// Skip the TASKS heading; everything after it is the task block.
		const inner = (row: string) => row.replace(/^\u2502 /, "").replace(/ +\u2502$/, "");
		const taskRows = rows
			.slice(rows.findIndex(row => row.includes("TASKS")) + 1)
			.map(inner)
			.filter(row => row.trim().length > 0);
		expect(taskRows.length).toBeGreaterThan(1);
		// The first row carries the glyph; continuation rows are indented to the
		// glyph column so they do not read as additional tasks.
		expect(taskRows[0]?.startsWith("  ")).toBe(false);
		expect(taskRows[1]?.startsWith("  ")).toBe(true);
	});

	it("collapses below its minimum width", () => {
		const sidebar = new StatusSidebar();
		sidebar.setState(fullState);
		expect(sidebar.render(SIDEBAR_MIN_WIDTH - 1)).toEqual([]);
		expect(sidebar.visible).toBe(false);
		expect(sidebar.render(SIDEBAR_MIN_WIDTH).length).toBeGreaterThan(0);
		expect(sidebar.visible).toBe(true);
	});

	it("clamps a requested width into the usable range", () => {
		expect(clampSidebarWidth(4)).toBe(SIDEBAR_MIN_WIDTH);
		expect(clampSidebarWidth(500)).toBe(SIDEBAR_MAX_WIDTH);
		expect(clampSidebarWidth(30)).toBe(30);
	});

	it("keeps the split cutoff above the pane minimum", () => {
		// A cutoff below the pane minimum would collapse the pane immediately.
		expect(SIDEBAR_SPLIT_AT).toBeGreaterThan(SIDEBAR_MIN_WIDTH * 2);
	});
});
