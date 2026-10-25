/**
 * Contracts: fullscreen session at the TUI layer.
 *
 * 1. `setFullscreenSession(true)` borrows the alternate buffer and paints the
 *    provider's screen there; nothing touches the normal screen or scrollback.
 * 2. The provider's frame is diffed like an overlay's, so a keystroke rewrites
 *    the rows it touched rather than the whole terminal.
 * 3. A history batch offered in this mode is refused and acknowledged instead
 *    of being written into a buffer that has no scrollback.
 * 4. Turning the mode off restores the normal screen.
 */
import { describe, expect, it } from "bun:test";
import { TUI, type TerminalFramePlan, type TerminalFrameProvider, type ViewportSize } from "@ngodeai/tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	takeWrites(): string {
		const out = this.writes.join("");
		this.writes.length = 0;
		return out;
	}
}

/** A provider whose screen is one mutable string array plus an optional history offer. */
class ScreenProvider implements TerminalFrameProvider {
	lines: string[];
	history: { id: number; rows: readonly string[] } | undefined;
	acknowledged: number[] = [];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const rows = this.lines.slice(0, viewport.rows);
		const plan: TerminalFramePlan = { viewport: rows };
		if (this.history !== undefined) return { ...plan, history: this.history };
		return plan;
	}

	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
	}
}

async function fullscreenTui(lines: string[], rows = 6) {
	const terminal = new RecordingTerminal(24, rows);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.start();
	await scheduler.settle(terminal);
	const provider = new ScreenProvider(lines);
	tui.setFrameProvider(provider);
	tui.setFullscreenSession(true);
	tui.requestRender(true);
	await scheduler.settle(terminal);
	const entry = terminal.takeWrites();
	return { terminal, scheduler, tui, provider, entry };
}

const screen = (terminal: VirtualTerminal): string[] => terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());

describe("fullscreen session", () => {
	it("paints the provider's screen on the alternate buffer", async () => {
		const lines = ["one", "two", "three", "four", "five", "six"];
		const { terminal, scheduler, tui, entry } = await fullscreenTui(lines);
		try {
			expect(screen(terminal)).toEqual(lines);
			// The alternate buffer is entered, and the normal screen's history is
			// never touched (no ED3).
			expect(entry).toContain("\x1b[?1049h");
			expect(entry).not.toContain("\x1b[3J");
		} finally {
			tui.stop();
			await scheduler.settle(terminal);
		}
	});

	it("rewrites only the rows that changed", async () => {
		const lines = ["one", "two", "three", "four", "five", "six"];
		const { terminal, scheduler, tui, provider } = await fullscreenTui(lines);
		try {
			provider.lines = ["one", "TWO CHANGED", "three", "four", "five", "six"];
			tui.requestRender();
			await scheduler.settle(terminal);
			const paint = terminal.takeWrites();
			expect(screen(terminal)).toEqual(provider.lines);
			for (const unchanged of ["one", "three", "four", "five", "six"]) expect(paint).not.toContain(unchanged);
		} finally {
			tui.stop();
			await scheduler.settle(terminal);
		}
	});

	it("refuses and acknowledges a history batch", async () => {
		const lines = ["one", "two", "three", "four", "five", "six"];
		const { terminal, scheduler, tui, provider } = await fullscreenTui(lines);
		try {
			provider.history = { id: 7, rows: ["retired row"] };
			tui.requestRender();
			await scheduler.settle(terminal);
			// Acknowledged so the provider stops re-offering it, and the row is
			// nowhere on screen: the alternate buffer cannot hold it.
			expect(provider.acknowledged).toEqual([7]);
			expect(screen(terminal).join("\n")).not.toContain("retired row");
			// The normal screen still has no scrollback written.
			expect(terminal.writes.join("")).not.toContain("retired row");
		} finally {
			tui.stop();
			await scheduler.settle(terminal);
		}
	});

	it("restores the normal screen when the mode turns off", async () => {
		const { terminal, scheduler, tui } = await fullscreenTui(["one", "two", "three", "four", "five", "six"]);
		try {
			tui.setFullscreenSession(false);
			tui.requestRender(true);
			await scheduler.settle(terminal);
			expect(terminal.writes.join("")).toContain("\x1b[?1049l");
		} finally {
			tui.stop();
			await scheduler.settle(terminal);
		}
	});
});
