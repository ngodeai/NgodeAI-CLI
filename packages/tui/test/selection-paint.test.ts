/**
 * Selection painting reaches the frame the TUI writes.
 *
 * The selector's own tests cover what text a drag covers. These cover the other
 * half: that the highlight actually replaces the rows about to be painted, and
 * that a repaint after the drag is over leaves them alone.
 */
import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@ngodeai/tui";
import type { Terminal, TerminalAppearance } from "@ngodeai/tui/terminal";
import { highlightSelection, normalizeSelection } from "../src/selection";

class MinimalTerminal implements Terminal {
	columns = 40;
	rows = 6;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	output = "";
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.output += data;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
}

function line(text: string): Component {
	return { render: () => [text] };
}

describe("selection painter", () => {
	it("paints the selected cells into the written frame", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		let range: ReturnType<typeof normalizeSelection> | undefined = {
			start: { row: 0, col: 0 },
			end: { row: 0, col: 2 },
		};
		tui.setSelectionPainter(rows => highlightSelection(rows, range));
		try {
			tui.start();
			tui.addChild(line("abcdef"));
			tui.renderNow();
			// The written buffer carries the inverse-video run.
			expect(terminal.output).toContain("\x1b[7m");
		} finally {
			tui.stop();
		}
	});

	it("leaves the frame untouched once the selection is cleared", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		let range: ReturnType<typeof normalizeSelection> | undefined = {
			start: { row: 0, col: 0 },
			end: { row: 0, col: 2 },
		};
		tui.setSelectionPainter(rows => highlightSelection(rows, range));
		try {
			tui.start();
			tui.addChild(line("abcdef"));
			tui.renderNow();
			const withSelection = terminal.output.length;

			range = undefined;
			tui.requestRender(true, { clearScrollback: true });
			tui.renderNow();
			const after = terminal.output.slice(withSelection);
			expect(after).not.toContain("\x1b[7m");
		} finally {
			tui.stop();
		}
	});

	it("exposes the painted rows for extraction", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		try {
			tui.start();
			tui.addChild(line("hello"));
			tui.addChild(line("world"));
			tui.renderNow();
			const rows = tui.getRenderedRows();
			expect(rows.some(row => row.includes("hello"))).toBe(true);
			expect(rows.some(row => row.includes("world"))).toBe(true);
		} finally {
			tui.stop();
		}
	});
});
