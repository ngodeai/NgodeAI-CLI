/**
 * In-app text selection.
 *
 * The property that matters: what a drag covers is what gets copied, with the
 * row's styling gone and its layout intact. A selection across a table must
 * keep its columns; a selection that ends past a short line must not carry the
 * padding with it.
 */
import { describe, expect, it } from "bun:test";
import { isMouseReport, parseAnyMouse, parseX10Mouse } from "../src/mouse";
import {
	extractSelection,
	highlightSelection,
	isEmptySelection,
	normalizeSelection,
	stripAnsi,
	TextSelector,
} from "../src/selection";

const ROWS = ["alpha beta gamma", "delta epsilon", "", "zeta eta theta"];

describe("normalizeSelection", () => {
	it("orders a forward drag", () => {
		expect(normalizeSelection({ row: 0, col: 2 }, { row: 1, col: 3 })).toEqual({
			start: { row: 0, col: 2 },
			end: { row: 1, col: 3 },
		});
	});

	it("orders a backward drag so start is never after end", () => {
		expect(normalizeSelection({ row: 2, col: 5 }, { row: 0, col: 1 })).toEqual({
			start: { row: 0, col: 1 },
			end: { row: 2, col: 5 },
		});
	});

	it("treats a same-row drag as ordered by column", () => {
		expect(normalizeSelection({ row: 1, col: 9 }, { row: 1, col: 2 })).toEqual({
			start: { row: 1, col: 2 },
			end: { row: 1, col: 9 },
		});
	});
});

describe("isEmptySelection", () => {
	it("is empty when both ends are the same cell", () => {
		expect(isEmptySelection({ start: { row: 0, col: 3 }, end: { row: 0, col: 3 } })).toBe(true);
	});

	it("is not empty across rows", () => {
		expect(isEmptySelection({ start: { row: 0, col: 3 }, end: { row: 1, col: 3 } })).toBe(false);
	});
});

describe("stripAnsi", () => {
	it("removes SGR colouring", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
	});

	it("removes OSC sequences", () => {
		expect(stripAnsi("\x1b]8;;https://x\x07link\x1b]8;;\x07")).toBe("link");
	});

	it("keeps the text of an unstyled row", () => {
		expect(stripAnsi("plain")).toBe("plain");
	});
});

describe("extractSelection", () => {
	it("takes the anchor column on the first row and the focus column on the last", () => {
		const text = extractSelection(ROWS, {
			start: { row: 0, col: 6 },
			end: { row: 1, col: 5 },
		});
		expect(text).toBe("beta gamma\ndelta");
	});

	it("takes whole rows between the ends", () => {
		const text = extractSelection(ROWS, {
			start: { row: 0, col: 0 },
			end: { row: 3, col: 4 },
		});
		// The blank third row survives as an empty line: it is inside the
		// selection, and dropping it would join two blocks that were separate.
		expect(text).toBe("alpha beta gamma\ndelta epsilon\n\nzeta");
	});

	it("trims the padding a drag past a short line would carry", () => {
		const rows = ["short", "a much longer line here"];
		const text = extractSelection(rows, { start: { row: 0, col: 0 }, end: { row: 0, col: 40 } });
		expect(text).toBe("short");
	});

	it("drops blank edge lines but keeps interior ones", () => {
		const rows = ["", "middle", ""];
		const text = extractSelection(rows, { start: { row: 0, col: 0 }, end: { row: 2, col: 0 } });
		expect(text).toBe("middle");
	});

	it("ignores a row index past the frame", () => {
		const text = extractSelection(ROWS, { start: { row: 0, col: 0 }, end: { row: 99, col: 0 } });
		expect(text).toContain("alpha");
	});

	it("keeps a table's column layout", () => {
		const rows = ["name      value", "alpha     1", "beta      2"];
		const text = extractSelection(rows, { start: { row: 0, col: 0 }, end: { row: 2, col: 14 } });
		expect(text.split("\n")[1]).toBe("alpha     1");
	});

	it("copies a wide glyph whole when the range starts inside it", () => {
		const rows = ["日本語テキスト"];
		// Column 1 falls inside the first wide character.
		const text = extractSelection(rows, { start: { row: 0, col: 1 }, end: { row: 0, col: 6 } });
		expect(text.startsWith("日")).toBe(true);
	});
});

describe("TextSelector", () => {
	it("returns nothing for a click with no drag", () => {
		const selector = new TextSelector();
		selector.begin({ row: 1, col: 2 });
		expect(selector.end(ROWS)).toBeUndefined();
	});

	it("returns the text a drag covered", () => {
		const selector = new TextSelector();
		selector.begin({ row: 0, col: 0 });
		selector.extend({ row: 0, col: 4 });
		expect(selector.end(ROWS)).toBe("alpha");
	});

	it("clears itself after ending, so the next press starts fresh", () => {
		const selector = new TextSelector();
		selector.begin({ row: 0, col: 0 });
		selector.extend({ row: 0, col: 4 });
		selector.end(ROWS);

		expect(selector.active).toBe(false);
		expect(selector.range).toBeUndefined();
	});

	it("abandons a drag on cancel", () => {
		const selector = new TextSelector();
		selector.begin({ row: 0, col: 0 });
		selector.extend({ row: 1, col: 5 });
		selector.cancel();

		expect(selector.active).toBe(false);
		expect(selector.end(ROWS)).toBeUndefined();
	});
});

describe("highlightSelection", () => {
	it("inverts only the covered cells", () => {
		const [line] = highlightSelection(["abcdef"], { start: { row: 0, col: 1 }, end: { row: 0, col: 3 } });
		expect(line).toBe("a\x1b[7mbcd\x1b[27mef");
	});

	it("leaves untouched rows identical", () => {
		const rows = highlightSelection(["one", "two"], { start: { row: 1, col: 0 }, end: { row: 1, col: 1 } });
		expect(rows[0]).toBe("one");
	});

	it("returns the rows unchanged when there is no range", () => {
		expect(highlightSelection(["a"], undefined)).toEqual(["a"]);
	});

	it("does not highlight a single-cell click", () => {
		const rows = highlightSelection(["abc"], { start: { row: 0, col: 1 }, end: { row: 0, col: 1 } });
		expect(rows[0]).toBe("abc");
	});
});

describe("X10 mouse reports", () => {
	/** X10 encodes each field offset by 32; coordinates are 1-based, so -33. */
	function x10(button: number, col: number, row: number): string {
		return `\x1b[M${String.fromCharCode(button + 32, col + 33, row + 33)}`;
	}

	it("decodes a press", () => {
		const event = parseX10Mouse(x10(0, 10, 5));
		expect(event?.leftClick).toBe(true);
		expect(event?.col).toBe(10);
		expect(event?.row).toBe(5);
	});

	it("decodes motion with the button held", () => {
		const event = parseX10Mouse(x10(32, 12, 6));
		expect(event?.motion).toBe(true);
		expect(event?.leftClick).toBe(false);
	});

	it("treats button 3 with no motion as a release", () => {
		// X10 has no explicit release: "no button" is how it says released.
		const event = parseX10Mouse(x10(3, 12, 6));
		expect(event?.release).toBe(true);
		expect(event?.leftClick).toBe(false);
	});

	it("decodes the wheel", () => {
		expect(parseX10Mouse(x10(64, 10, 5))?.wheel).toBe(-1);
		expect(parseX10Mouse(x10(65, 10, 5))?.wheel).toBe(1);
	});

	it("rejects a truncated report", () => {
		expect(parseX10Mouse("\x1b[M")).toBeNull();
		expect(parseX10Mouse("\x1b[M\x20\x21")).toBeNull();
	});

	it("rejects a non-mouse escape", () => {
		expect(parseX10Mouse("\x1b[A")).toBeNull();
	});

	it("parses either dialect through parseAnyMouse", () => {
		expect(parseAnyMouse("\x1b[<0;10;5M")?.leftClick).toBe(true);
		expect(parseAnyMouse(x10(0, 10, 5))?.leftClick).toBe(true);
	});

	it("recognises both dialects as mouse reports", () => {
		expect(isMouseReport("\x1b[<0;1;1M")).toBe(true);
		expect(isMouseReport("\x1b[M\x20\x21\x21")).toBe(true);
		expect(isMouseReport("\x1b[A")).toBe(false);
	});
});
