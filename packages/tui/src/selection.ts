/**
 * In-app text selection.
 *
 * A terminal cannot both report pointer motion and keep its own drag-select:
 * enabling `1003h` hands every motion event to the application, and the
 * terminal stops selecting. Terminals that support Shift+drag offer an escape,
 * but not all do, and requiring a modifier to copy is a poor default.
 *
 * This module takes the other path: the application does the selecting itself.
 * Pointer press anchors a cell, motion extends the range, release copies the
 * text through OSC 52. The terminal keeps reporting motion, so hover still
 * works, and copying needs no modifier.
 *
 * ## What "selected" means
 *
 * Selection is a **cell range over rendered rows**, not a document range. The
 * TUI paints a frame of strings; a user drags across what they can see. Rows
 * are already ANSI-styled, so extraction strips escapes and pads nothing: a
 * selection across a table keeps its columns because the spaces are in the
 * row text.
 *
 * Trailing whitespace is trimmed per line and blank edge lines are dropped,
 * because a drag almost always ends past the end of a short line and nobody
 * wants the padding.
 *
 * ## Where it does not apply
 *
 * The alternate screen (fullscreen overlays) owns every row and has no
 * scrollback; selection there is a different problem and is left to the
 * terminal, which still offers Shift+drag. This module is for the normal
 * buffer, where the transcript is.
 */

/** One end of a selection: a row in the rendered frame and a column within it. */
export interface SelectionPoint {
	/** 0-based row, indexed into the frame the TUI painted. */
	row: number;
	/** 0-based column, in display cells. */
	col: number;
}

/** A selection between two points, normalized so `start` is never after `end`. */
export interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

/**
 * Normalize two drag endpoints into a range.
 *
 * A drag can go up and to the left as easily as down and to the right; the
 * range is ordered by position so extraction never has to think about which
 * end the user started from.
 */
export function normalizeSelection(anchor: SelectionPoint, focus: SelectionPoint): SelectionRange {
	const anchorFirst = anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col);
	return anchorFirst ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/** Whether the range covers nothing (a click, not a drag). */
export function isEmptySelection(range: SelectionRange): boolean {
	return range.start.row === range.end.row && range.start.col === range.end.col;
}

/** Strip SGR/CSI/OSC sequences and keep the visible text. */
export function stripAnsi(line: string): string {
	// Covers SGR (`m`), cursor moves, OSC (BEL- or ST-terminated), and the
	// two-byte escapes a styled row can carry.
	return line
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
		.replace(/\x1b[@-_]/g, "");
}

function isWide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f64f) ||
		(code >= 0x1f900 && code <= 0x1f9ff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

/** `line` reduced to the cells between `from` and `to` (inclusive), escapes dropped. */
function sliceCells(line: string, from: number, to: number): string {
	const plain = stripAnsi(line);
	let col = 0;
	let out = "";
	for (const char of plain) {
		const width = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
		const next = col + width;
		// A cell is included when any part of it falls inside the range, so a
		// wide glyph straddling an edge is copied whole rather than halved.
		if (next > from && col <= to) out += char;
		col = next;
		if (col > to) break;
	}
	return out;
}

/**
 * The text a selection covers.
 *
 * One line per selected row. The first row starts at the anchor column and the
 * last ends at the focus column; every row between is taken whole. Each line's
 * trailing whitespace is trimmed, because a drag past a short line would
 * otherwise copy the padding to the right of it.
 */
export function extractSelection(rows: readonly string[], range: SelectionRange): string {
	const { start, end } = range;
	const lines: string[] = [];
	for (let row = start.row; row <= end.row; row++) {
		const line = rows[row];
		if (line === undefined) continue;
		const from = row === start.row ? start.col : 0;
		const to = row === end.row ? end.col : Number.MAX_SAFE_INTEGER;
		lines.push(sliceCells(line, from, to).trimEnd());
	}
	// A drag usually starts or ends on a blank row (a gap between blocks), and a
	// leading or trailing blank line is never what the user meant to copy.
	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

/**
 * Tracks a drag across rendered rows and turns it into text.
 *
 * The owner feeds it the frame it painted and the pointer events it decoded;
 * the tracker keeps no reference to the frame, so a repaint mid-drag cannot
 * leave it holding a stale row.
 */
export class TextSelector {
	#anchor: SelectionPoint | undefined;
	#focus: SelectionPoint | undefined;

	/** Whether a drag is in progress. */
	get active(): boolean {
		return this.#anchor !== undefined;
	}

	/** The current range, or `undefined` before a press. */
	get range(): SelectionRange | undefined {
		if (!this.#anchor || !this.#focus) return undefined;
		return normalizeSelection(this.#anchor, this.#focus);
	}

	/** Begin a drag at `point`. */
	begin(point: SelectionPoint): void {
		this.#anchor = point;
		this.#focus = point;
	}

	/** Extend the drag to `point`. */
	extend(point: SelectionPoint): void {
		if (!this.#anchor) return;
		this.#focus = point;
	}

	/** End the drag. Returns the selected text, or `undefined` when nothing was selected. */
	end(rows: readonly string[]): string | undefined {
		const range = this.range;
		this.#anchor = undefined;
		this.#focus = undefined;
		if (!range || isEmptySelection(range)) return undefined;
		const text = extractSelection(rows, range);
		return text.length > 0 ? text : undefined;
	}

	/** Abandon the drag without producing text. */
	cancel(): void {
		this.#anchor = undefined;
		this.#focus = undefined;
	}
}

/**
 * Highlight a selection by inverting the covered cells.
 *
 * Inverse video is the one style every terminal renders, and it needs no theme
 * colour: the selected text stays readable whatever the underlying style was.
 * Applying it to the styled row rather than the plain text keeps the rest of
 * the line's colour intact.
 */
export function highlightSelection(rows: readonly string[], range: SelectionRange | undefined): readonly string[] {
	if (!range || isEmptySelection(range)) return rows;
	return rows.map((line, row) => {
		if (row < range.start.row || row > range.end.row) return line;
		const from = row === range.start.row ? range.start.col : 0;
		const to = row === range.end.row ? range.end.col : Number.MAX_SAFE_INTEGER;
		return invertCells(line, from, to);
	});
}

/**
 * Wrap the cells between `from` and `to` in reverse video.
 *
 * Operates on the plain text with the row's escapes stripped, then re-emits
 * the segment inverted. Losing the original colouring inside the selection is
 * the point: a selected run should read as selected, not as its own styling.
 */
function invertCells(line: string, from: number, to: number): string {
	const plain = stripAnsi(line);
	let col = 0;
	let before = "";
	let selected = "";
	let after = "";
	for (const char of plain) {
		const width = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
		const next = col + width;
		if (next <= from) before += char;
		else if (col > to) after += char;
		else selected += char;
		col = next;
	}
	if (selected === "") return line;
	return `${before}\x1b[7m${selected}\x1b[27m${after}`;
}
