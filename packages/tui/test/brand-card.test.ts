import { beforeAll, describe, expect, it } from "bun:test";
import {
	brandBottom,
	brandDivider,
	brandDividerSplit,
	brandRow,
	brandSplitRow,
	brandTop,
	brandTopSplit,
} from "../src/chrome/overlay-box";
import { initTheme } from "../src/theme";
import { visibleWidth } from "../src/utils";

beforeAll(async () => {
	await initTheme();
});

const plain = (row: string) => Bun.stripANSI(row);

describe("brand card frame", () => {
	/**
	 * Every row must be exactly the requested width: the overlay composes these
	 * into a full-screen surface, and a row one cell short shears the right rule.
	 */
	it("renders every row at the requested width", () => {
		for (const width of [40, 80, 120]) {
			const rows = [
				brandTop(width, "Agent Hub"),
				brandRow("content", width),
				brandDivider(width),
				brandTopSplit(width, "Agent Hub", Math.floor(width * 0.58)),
				brandSplitRow("left", "right", width, Math.floor(width * 0.58)),
				brandDividerSplit(width, Math.floor(width * 0.58)),
				brandBottom(width),
			];
			for (const row of rows) expect(visibleWidth(plain(row))).toBe(width);
		}
	});

	/** The corners are square dots, not the rounded box's arcs. */
	it("uses square dots at the corners", () => {
		const top = plain(brandTop(60, "Agent Hub"));
		const bottom = plain(brandBottom(60));
		expect(top.startsWith("▪")).toBe(true);
		expect(top.endsWith("▪")).toBe(true);
		expect(bottom.startsWith("▪")).toBe(true);
		expect(bottom.endsWith("▪")).toBe(true);
		// No rounded-box glyphs leak through.
		expect(top).not.toContain("╭");
		expect(bottom).not.toContain("╰");
	});

	/** The title sits inside the top rule, not on a separate line. */
	it("insets the title into the top rule", () => {
		const top = plain(brandTop(60, "Agent Hub"));
		expect(top).toContain("Agent Hub");
		expect(top.split("\n")).toHaveLength(1);
	});

	/** Section breaks carry dots so they read as part of the same card. */
	it("marks section breaks with dots", () => {
		const divider = plain(brandDivider(60));
		expect(divider.startsWith("▪")).toBe(true);
		expect(divider.endsWith("▪")).toBe(true);

		const split = plain(brandDividerSplit(60, 30));
		expect(split.startsWith("▪")).toBe(true);
		expect(split.endsWith("▪")).toBe(true);
		// The pane divider crosses the rule.
		expect(split).toContain("│");
	});

	/** Content rows carry a vertical rule on both sides. */
	it("frames content rows with vertical rules", () => {
		const row = plain(brandRow("hello", 40));
		expect(row.startsWith("│")).toBe(true);
		expect(row.endsWith("│")).toBe(true);
		expect(row).toContain("hello");
	});
});
