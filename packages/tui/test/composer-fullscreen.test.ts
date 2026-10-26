/**
 * Contracts: fullscreen session.
 *
 * 1. The whole document lives in the viewport. Nothing retires into native
 *    history, because the alternate buffer has none.
 * 2. The chrome below the transcript — editor, status line, HUDs — keeps its
 *    rows at the bottom of the screen while the transcript scrolls above it.
 * 3. `scrollBy` moves a window through the document and clamps at both ends;
 *    new output does not move that window while the reader is scrolled up.
 * 4. Frames never carry a history batch.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@ngodeai/tui/prompt/composer";
import { TranscriptContainer } from "@ngodeai/tui/chrome/transcript-container";
import { Text } from "@ngodeai/tui";
import { initTheme } from "@ngodeai/tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

const CHROME_ROWS = 4;

/** A started fullscreen composer with `blocks` transcript blocks and pinned chrome. */
function fullscreenComposer(options: { blocks: number; rows: number; columns: number; linesPerBlock?: number }) {
	const lines = options.linesPerBlock ?? 3;
	const term = new VirtualTerminal(options.columns, options.rows);
	const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
	composer.start();
	const transcript = new TranscriptContainer();
	for (let index = 0; index < options.blocks; index++) {
		const body = Array.from({ length: lines }, (_, line) => `block ${index} line ${line}`).join("\n");
		transcript.addChild(new Text(body, 0, 0));
	}
	// Stand-in for the editor and status line: fixed rows below the transcript.
	const chrome = new Text(Array.from({ length: CHROME_ROWS }, (_, row) => `chrome ${row}`).join("\n"), 0, 0);
	composer.setRuntimeChildren([transcript, chrome]);
	composer.setFullscreen(true);
	return { composer, term, transcript };
}

const plain = (rows: readonly string[]): string[] => rows.map(row => Bun.stripANSI(row).trimEnd());

describe("fullscreen session", () => {
	it("paints a window of the document over pinned chrome", () => {
		const { composer } = fullscreenComposer({ blocks: 20, rows: 20, columns: 80 });
		try {
			const rows = plain(composer.renderFrame({ columns: 80, rows: 20 }).viewport);
			expect(rows).toHaveLength(20);
			// Chrome occupies the last rows, in order, regardless of the transcript.
			expect(rows.slice(-CHROME_ROWS)).toEqual(["chrome 0", "chrome 1", "chrome 2", "chrome 3"]);
			// The transcript window ends at the newest output.
			expect(rows.slice(0, -CHROME_ROWS).join("\n")).toContain("block 19");
		} finally {
			composer.stop();
		}
	});

	it("never offers native history", () => {
		const { composer } = fullscreenComposer({ blocks: 60, rows: 20, columns: 80 });
		try {
			const plan = composer.renderFrame({ columns: 80, rows: 20 });
			expect(plan.history).toBeUndefined();
			expect(plain(plan.viewport).slice(-CHROME_ROWS)[0]).toBe("chrome 0");
		} finally {
			composer.stop();
		}
	});

	it("scrolls the transcript while chrome stays put", () => {
		const { composer } = fullscreenComposer({ blocks: 30, rows: 20, columns: 80 });
		try {
			const before = plain(composer.renderFrame({ columns: 80, rows: 20 }).viewport);
			expect(before.join("\n")).toContain("block 29");

			composer.scrollBy(10);
			const after = plain(composer.renderFrame({ columns: 80, rows: 20 }).viewport);
			// Chrome rows are identical; only the transcript window moved.
			expect(after.slice(-CHROME_ROWS)).toEqual(before.slice(-CHROME_ROWS));
			expect(after.join("\n")).not.toContain("block 29");
		} finally {
			composer.stop();
		}
	});

	it("clamps at the top and the tail", () => {
		const { composer } = fullscreenComposer({ blocks: 8, rows: 20, columns: 80 });
		try {
			// A document shorter than the window: no scrolling at all.
			expect(composer.scrollBy(50)).toBe(false);
			expect(composer.scrollOffset).toBe(0);
			expect(composer.scrollBy(-50)).toBe(false);
			expect(composer.scrollOffset).toBe(0);

			const tall = fullscreenComposer({ blocks: 40, rows: 16, columns: 80 });
			try {
				tall.composer.renderFrame({ columns: 80, rows: 16 });
				// Overshooting the top clamps instead of painting an empty screen.
				expect(tall.composer.scrollBy(10_000)).toBe(true);
				const top = plain(tall.composer.renderFrame({ columns: 80, rows: 16 }).viewport);
				// The first document row is visible; the window may hang from the
				// bottom (blank filler above) when the top of the ledger is nearer
				// than one screenful.
				expect(top.join("\n")).toContain("block 0 line 0");
				expect(top.join("\n")).not.toContain("block 39");

				tall.composer.scrollToEdge("bottom");
				expect(tall.composer.scrollOffset).toBe(0);
				const tail = plain(tall.composer.renderFrame({ columns: 80, rows: 16 }).viewport);
				expect(tail.join("\n")).toContain("block 39");
			} finally {
				tall.composer.stop();
			}
		} finally {
			composer.stop();
		}
	});

	it("keeps a reader's position when output arrives", () => {
		const { composer, transcript } = fullscreenComposer({ blocks: 30, rows: 20, columns: 80 });
		try {
			// The document height is measured by a frame; scroll only has bounds
			// to clamp against after the first paint.
			composer.renderFrame({ columns: 80, rows: 20 });
			composer.scrollBy(15);
			const scrolled = composer.scrollOffset;
			expect(scrolled).toBeGreaterThan(0);
			const before = plain(composer.renderFrame({ columns: 80, rows: 20 }).viewport);

			// New output while scrolled up must not yank the window to the tail.
			transcript.addChild(new Text("a brand new block", 0, 0));
			const after = plain(composer.renderFrame({ columns: 80, rows: 20 }).viewport);
			// The offset counts rows up from the tail, so new output shifts the
			// window with the document instead of yanking it to the bottom: the
			// reader keeps their distance from the newest row.
			expect(composer.scrollOffset).toBe(scrolled);
			expect(after.join("\n")).not.toContain("a brand new block");
			expect(after.slice(-CHROME_ROWS)).toEqual(before.slice(-CHROME_ROWS));
		} finally {
			composer.stop();
		}
	});

	/**
	 * A window that came back short used to be padded with blank filler at the
	 * top, so a full screen of output showed a band of empty rows above it.
	 * The transcript must fill its allocation exactly when the document is at
	 * least that tall.
	 */
	it("fills the transcript area with no blank band above it", () => {
		const { composer } = fullscreenComposer({ blocks: 60, rows: 24, columns: 80, linesPerBlock: 1 });
		try {
			const rows = plain(composer.renderFrame({ columns: 80, rows: 24 }).viewport);
			const transcriptRows = rows.slice(0, -CHROME_ROWS);
			expect(transcriptRows[0]).not.toBe("");
			// Every transcript row is content or the separator between two blocks;
			// no run of blanks at the head.
			expect(transcriptRows.findIndex(row => row !== "")).toBe(0);
		} finally {
			composer.stop();
		}
	});

	/** Chrome that opens with its own blank must not get a second separator row. */
	it("does not double the blank above chrome that starts blank", () => {
		const { composer, term } = fullscreenComposer({ blocks: 40, rows: 20, columns: 80 });
		try {
			const withBlank = new Text("\nTODO", 0, 0);
			composer.setRuntimeChildren([new TranscriptContainer(), withBlank]);
			const rows = plain(composer.renderFrame({ columns: 80, rows: 20 }).viewport);
			// One blank above the HUD, not two: the HUD's own leading blank is the
			// separator, so the composer adds none of its own.
			expect(rows.slice(-2)).toEqual(["", "TODO"]);
			expect(rows.at(-3)).not.toBe("");
		} finally {
			composer.stop();
		}
	});

	it("follows the tail again once the reader returns to it", () => {
		const { composer, transcript } = fullscreenComposer({ blocks: 30, rows: 20, columns: 80 });
		try {
			composer.renderFrame({ columns: 80, rows: 20 });
			composer.scrollBy(20);
			composer.scrollToEdge("bottom");
			expect(composer.scrollOffset).toBe(0);

			transcript.addChild(new Text("fresh output", 0, 0));
			const rows = plain(composer.renderFrame({ columns: 80, rows: 20 }).viewport);
			expect(rows.join("\n")).toContain("fresh output");
		} finally {
			composer.stop();
		}
	});
});
