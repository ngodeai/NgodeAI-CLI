import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { pickWeightedTip, WelcomeComponent } from "@ngodeai/tui/prompt/welcome";
import { initTheme, theme } from "@ngodeai/tui/theme";
import { visibleWidth } from "@ngodeai/tui";

describe("WelcomeComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("natively sets the version under the wordmark beside the logo", () => {
		const tree = new WelcomeComponent("18.4.12").describe({} as never);
		expect(tree.c?.[0]).toMatchObject({
			key: "lockup",
			p: { role: "ngodeai.welcome.lockup" },
			c: [
				{ k: "image", key: "logo" },
				{
					k: "col",
					p: { role: "ngodeai.welcome.mark" },
					c: [
						{ p: { role: "ngodeai.welcome.wordmark" } },
						{ p: { role: "ngodeai.welcome.version", spans: [{ t: "v18.4.12" }] } },
					],
				},
			],
		});
	});

	it("selects standard tip when preset is not unicode", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");

		const welcome = new WelcomeComponent("1.0.0");
		expect(welcome.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcome.tip).toBeDefined();
	});

	it("selects nerdfont tip with 10% probability under unicode preset", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");

		// 9% chance => selects special tip
		vi.spyOn(Math, "random").mockReturnValue(0.09);
		const welcomeSpecial = new WelcomeComponent("1.0.0");
		expect(welcomeSpecial.tip).toBe("Please use nerdfont 😭.");

		// 10% chance => selects regular tip
		vi.spyOn(Math, "random").mockReturnValue(0.1);
		const welcomeRegular = new WelcomeComponent("1.0.0");
		expect(welcomeRegular.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcomeRegular.tip).toBeDefined();
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});

	it("centers the lockup and every tip line in the terminal width", () => {
		const columns = 140;
		const rows = new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row).trimEnd());
		const indent = (row: string) => visibleWidth(row) - visibleWidth(row.trimStart());
		const expectCentered = (left: number, right: number) => expect(Math.abs(left - right)).toBeLessThanOrEqual(1);

		// The card frames the lockup: its first and last rows are the square-dot
		// rules, and the tagline sits beside the mark.
		const top = rows.findIndex(row => row.trimStart().startsWith("▪"));
		const bottom = rows.findLastIndex(row => row.trimStart().startsWith("▪"));
		expect(top).toBeGreaterThanOrEqual(0);
		expect(bottom).toBeGreaterThan(top);

		// Every row between the rules is a card row and centers inside it.
		for (const row of rows.slice(top + 1, bottom)) {
			if (row.length === 0) continue;
			expect(row.trimStart().startsWith("│")).toBe(true);
			expect(row.trimEnd().endsWith("│")).toBe(true);
		}

		// Each tip line centers on its own.
		const tipStart = rows.findIndex(row => row.includes("Tip: "));
		expect(tipStart).toBeGreaterThan(top);
		const below = rows.slice(tipStart).filter(row => row.length > 0);
		expect(below.length).toBeGreaterThanOrEqual(1);
		for (const row of below) expectCentered(indent(row), columns - visibleWidth(row));
	});

	it("drops the tip below 50 columns", () => {
		const text = (columns: number) => Bun.stripANSI(new WelcomeComponent("1.0.0").render(columns).join("\n"));
		expect(text(50)).toContain("Tip: ");
		expect(text(49)).not.toContain("Tip: ");
		expect(text(49)).toContain("v1.0.0");
	});

	it("shows the tagline beside the mark when wide, stacked when narrow", () => {
		const rows = (columns: number) => new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row));
		const TAGLINE = "Powerful Coding Models without Masking";

		// Wide: the tagline and version share a row with the glyphs.
		const wide = rows(140);
		const beside = wide.find(row => row.includes(TAGLINE));
		expect(beside).toBeDefined();
		expect(beside).toContain("█");
		expect(wide.some(row => row.includes("v1.0.0"))).toBe(true);

		// Narrow: the tagline drops below the mark instead of disappearing.
		const narrow = rows(70);
		const stacked = narrow.find(row => row.includes(TAGLINE));
		expect(stacked).toBeDefined();
		expect(stacked).not.toContain("█");
		expect(narrow.some(row => row.includes("v1.0.0"))).toBe(true);
	});
});
