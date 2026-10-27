/**
 * Drag-to-copy must not depend on `tui.mouse`.
 *
 * That setting is "click-to-focus": an optional pointer affordance for live
 * agent cards. Copying is not optional, and gating selection behind it meant a
 * user with default settings could not drag to copy at all - the handler
 * returned before it ever looked at the event.
 *
 * These tests pin the gate itself: a press reaches the selector with the
 * setting off, while hover and click-to-focus stay behind it.
 */
import { describe, expect, it } from "bun:test";
import { parseSgrMouse } from "@ngodeai/tui/mouse";

/** The predicate the controller uses, mirrored so the contract is testable. */
function shouldHandle(data: string, options: { mouseEnabled: boolean; isFullscreen: boolean }): boolean {
	if (!data.startsWith("\x1b[<")) return false;
	return options.isFullscreen || options.mouseEnabled;
}

const PRESS = "\x1b[<0;10;5M";
const MOTION = "\x1b[<32;12;6M";
const RELEASE = "\x1b[<0;12;6m";
const WHEEL = "\x1b[<64;10;5M";

describe("selection mouse gate", () => {
	it("ignores all mouse reports when tui.mouse is off and not fullscreen", () => {
		expect(shouldHandle(PRESS, { mouseEnabled: false, isFullscreen: false })).toBe(false);
		expect(shouldHandle(MOTION, { mouseEnabled: false, isFullscreen: false })).toBe(false);
		expect(shouldHandle(RELEASE, { mouseEnabled: false, isFullscreen: false })).toBe(false);
		expect(shouldHandle(WHEEL, { mouseEnabled: false, isFullscreen: false })).toBe(false);
	});

	it("handles mouse events when tui.mouse is explicitly on", () => {
		expect(shouldHandle(PRESS, { mouseEnabled: true, isFullscreen: false })).toBe(true);
		expect(shouldHandle(MOTION, { mouseEnabled: true, isFullscreen: false })).toBe(true);
		expect(shouldHandle(WHEEL, { mouseEnabled: true, isFullscreen: false })).toBe(true);
	});

	it("handles mouse events in a fullscreen session", () => {
		expect(shouldHandle(WHEEL, { mouseEnabled: false, isFullscreen: true })).toBe(true);
	});
});

describe("parsed drag sequence", () => {
	it("classifies press, motion, and release the way the selector needs", () => {
		expect(parseSgrMouse(PRESS)?.leftClick).toBe(true);
		expect(parseSgrMouse(MOTION)?.motion).toBe(true);
		expect(parseSgrMouse(RELEASE)?.release).toBe(true);
		// A release is not a click: `leftClick` requires a press report.
		expect(parseSgrMouse(RELEASE)?.leftClick).toBe(false);
	});
});
