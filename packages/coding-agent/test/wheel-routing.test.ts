/**
 * Where the wheel goes.
 *
 * The two screen modes need opposite answers, and getting it wrong is silent:
 * a consumed wheel scrolls nothing, and the user simply cannot move the
 * transcript. Fullscreen owns every row and has no scrollback, so the
 * application must scroll. Inline lives in the terminal's scrollback and
 * `composer.scrollBy` refuses to move it at all, so the event must be left
 * alone for the terminal to handle.
 */
import { describe, expect, it } from "bun:test";
import { parseAnyMouse } from "@ngodeai/tui/mouse";

/** The wheel branch of the mouse handler, mirrored so the contract is testable. */
function routeWheel(
	event: ReturnType<typeof parseAnyMouse>,
	options: { isFullscreen: boolean },
): "scroll-composer" | "pass-through" | "none" {
	if (!event || event.wheel === null) return "none";
	return options.isFullscreen ? "scroll-composer" : "pass-through";
}

const WHEEL_UP = "\x1b[<64;10;5M";
const WHEEL_DOWN = "\x1b[<65;10;5M";
const PRESS = "\x1b[<0;10;5M";

describe("wheel routing", () => {
	it("scrolls the composer in a fullscreen session", () => {
		expect(routeWheel(parseAnyMouse(WHEEL_UP), { isFullscreen: true })).toBe("scroll-composer");
		expect(routeWheel(parseAnyMouse(WHEEL_DOWN), { isFullscreen: true })).toBe("scroll-composer");
	});

	/**
	 * The regression: inline sessions had their wheel consumed while the
	 * composer refused to move, so nothing scrolled in either layer.
	 */
	it("leaves the wheel to the terminal in an inline session", () => {
		expect(routeWheel(parseAnyMouse(WHEEL_UP), { isFullscreen: false })).toBe("pass-through");
		expect(routeWheel(parseAnyMouse(WHEEL_DOWN), { isFullscreen: false })).toBe("pass-through");
	});

	it("does not treat a press as a wheel", () => {
		expect(routeWheel(parseAnyMouse(PRESS), { isFullscreen: true })).toBe("none");
	});

	it("decodes the X10 wheel conhost sends", () => {
		const up = parseAnyMouse(`\x1b[M${String.fromCharCode(64 + 32, 10 + 33, 5 + 33)}`);
		expect(up?.wheel).toBe(-1);
		expect(routeWheel(up, { isFullscreen: false })).toBe("pass-through");
		expect(routeWheel(up, { isFullscreen: true })).toBe("scroll-composer");
	});
});
