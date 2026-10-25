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

	/**
	 * The sidebar shares the screen with the transcript, so a row one cell too
	 * wide wraps in the terminal and shears the whole frame.
	 */
	it("never emits a row wider than the pane", () => {
		for (const width of [SIDEBAR_MIN_WIDTH, 26, 32, SIDEBAR_MAX_WIDTH]) {
			const sidebar = new StatusSidebar();
			sidebar.setState(fullState);
			for (const row of plain(sidebar.render(width))) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}
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
		const taskRows = rows
			.slice(rows.findIndex(row => row.includes("TASKS")) + 1)
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
