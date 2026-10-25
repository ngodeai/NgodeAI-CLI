import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@ngodeai/tui/prompt/composer";
import { TranscriptContainer } from "@ngodeai/tui/chrome/transcript-container";
import { Text } from "@ngodeai/tui";
import { SIDEBAR_SPLIT_AT } from "../src/components/sidebar";
import { initTheme } from "@ngodeai/tui/theme";
import { visibleWidth } from "@ngodeai/tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

/** A started composer with one short transcript block, ready to split. */
function composerWith(rows: number, columns: number) {
	const term = new VirtualTerminal(columns, rows);
	const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
	composer.start();
	const transcript = new TranscriptContainer();
	// Deliberately short lines: the bug was that unpadded transcript rows let
	// the divider slide left on every row that did not fill the pane. Enough of
	// them to fill the viewport, which is when the pane had to extend its frame.
	transcript.addChild(new Text("short", 0, 0));
	transcript.addChild(new Text("another short line", 0, 0));
	for (let index = 0; index < 40; index++) transcript.addChild(new Text(`filler ${index}`, 0, 0));
	composer.setRuntimeChildren([transcript]);
	composer.setSidebar({
		tasks: [{ name: "", tasks: [{ content: "do the thing", status: "in_progress" }] }],
		context: { usedTokens: 1000, maxTokens: 10000, percent: 10 },
	});
	return { composer, term };
}

describe("composer sidebar split", () => {
	/**
	 * Every row must be exactly the terminal width and the divider must sit in
	 * the same column on all of them. A row that renders shorter than the pane
	 * used to push the divider (and the whole sidebar) left, so the frame
	 * overlapped the transcript.
	 */
	it("keeps the divider in one column across every row", () => {
		const columns = 120;
		const { composer, term } = composerWith(30, columns);
		try {
			const rows = composer.renderFrame({ columns, rows: 30 }).viewport.map(row => Bun.stripANSI(row));
			expect(rows.length).toBeGreaterThan(2);

			const widths = new Set(rows.map(row => visibleWidth(row)));
			expect([...widths]).toEqual([columns]);

			// The split divider is the first `│` on a row; it must never move.
			const dividerColumns = new Set(rows.map(row => row.indexOf("│")));
			expect(dividerColumns.size).toBe(1);
		} finally {
			composer.stop();
		}
	});

	/** The sidebar's frame must run the full height, not stop after its sections. */
	it("closes the sidebar frame on the last row", () => {
		const columns = 120;
		const { composer, term } = composerWith(40, columns);
		try {
			const rows = composer.renderFrame({ columns, rows: 40 }).viewport.map(row => Bun.stripANSI(row));
			// Exactly one top rule and one bottom rule, and the bottom one is on
			// the pane's last row. Two closing rules (one after the last section,
			// one at the viewport's end) left a band of empty frame between them.
			const rules = rows.filter(row => row.includes("▪"));
			expect(rules.length).toBe(2);
			expect(rules[0]).toBe(rows[0]);
			expect(rules[1]).toBe(rows[rows.length - 1]);
			// Every row ends with a right rule or the closing corner dot.
			for (const row of rows) expect(row.endsWith("│") || row.endsWith("▪")).toBe(true);
		} finally {
			composer.stop();
		}
	});

	it("gives the transcript the full width below the split cutoff", () => {
		const columns = SIDEBAR_SPLIT_AT - 1;
		const { composer, term } = composerWith(20, columns);
		try {
			const rows = composer.renderFrame({ columns, rows: 20 }).viewport.map(row => Bun.stripANSI(row));
			expect(composer.sidebarVisible).toBe(false);
			expect(rows.some(row => row.includes("TASKS"))).toBe(false);
		} finally {
			composer.stop();
		}
	});
});
