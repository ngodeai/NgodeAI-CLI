/**
 * Every tool result is framed.
 *
 * The transcript used to mix boxed cards with bare text: `proc://` listings,
 * `cfg://` reads and the generic fallback for tools without a renderer all
 * drew as free-standing paragraphs, which read as something the model had
 * written rather than as a tool outcome. This pins the frame on each of them.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@ngodeai/tui/theme";
import { renderCfgRead, renderCfgWrite } from "@ngodeai/tui/tools/cfg-render";
import { renderDefaultToolExecution } from "@ngodeai/tui/tools/default-renderer";
import { renderProcRead, renderProcWrite } from "@ngodeai/tui/tools/proc-render";
import type { RenderResultOptions } from "@ngodeai/tui/tools/renderer";

beforeAll(async () => {
	await initTheme(false);
});

const options: RenderResultOptions = { expanded: false, isPartial: false };

/** Rows with ANSI stripped, ready for structural assertions. */
function paint(component: { render(width: number): readonly string[] }, width = 80): string[] {
	return component.render(width).map(row => Bun.stripANSI(row));
}

/**
 * The frame's four marks. `boxBrand` is what `renderOutputBlock` draws — square
 * dots, matching the composer, the sidebar and the setup screens — and the
 * corners are the cheapest proof that a card owns its border.
 */
function expectFramed(rows: readonly string[], width = 80): void {
	expect(rows.length).toBeGreaterThanOrEqual(2);
	expect(rows[0]!.startsWith("▪")).toBe(true);
	expect(rows[0]!.endsWith("▪")).toBe(true);
	expect(rows.at(-1)!.startsWith("▪")).toBe(true);
	expect(rows.at(-1)!.endsWith("▪")).toBe(true);
	// No rounded-box glyphs leak through.
	expect(rows.join("\n")).not.toMatch(/[╭╮╰╯]/);
	for (const row of rows) expect(Bun.stringWidth(row)).toBe(width);
}

describe("tool card framing", () => {
	it("frames a proc listing", () => {
		const jobs = [
			{ id: "bg_1", type: "bash" as const, status: "running" as const, label: "server", durationMs: 2500 },
			{ id: "bg_2", type: "task" as const, status: "completed" as const, label: "scan", durationMs: 5100 },
		];
		const details = { jobs, daemons: [], agents: [] };
		const component = renderProcRead("", { content: [{ type: "text", text: "" }] }, details, options, theme);
		const rows = paint(component);
		expectFramed(rows);
		expect(rows.join("\n")).toContain("Proc jobs & services");
		expect(rows.join("\n")).toContain("bg_1");
	});

	it("frames a proc write", () => {
		const component = renderProcWrite(
			"bg_1",
			"kill",
			undefined,
			{ content: [{ type: "text", text: "stopped" }] },
			undefined,
			options,
			theme,
		);
		const rows = paint(component);
		expectFramed(rows);
		expect(rows.join("\n")).toContain("Proc kill bg_1");
	});

	it("frames a config read", () => {
		const component = renderCfgRead(
			"cfg://theme",
			{ content: [{ type: "text", text: "theme.dark: dark\n" }] },
			{ count: 1, modified: 0, path: "theme" },
			options,
			theme,
		);
		const rows = paint(component);
		expectFramed(rows);
		expect(rows.join("\n")).toContain("theme.dark: dark");
	});

	it("frames a config write", () => {
		const component = renderCfgWrite(
			"cfg://theme/dark",
			"dark-terminal",
			{ content: [{ type: "text", text: "ok" }] },
			{ path: "theme.dark", previous: "titanium", value: "dark-terminal", outcome: "applied", save: false },
			options,
			theme,
		);
		const rows = paint(component);
		expectFramed(rows);
		expect(rows.join("\n")).toContain("dark-terminal");
	});

	it("frames the generic fallback for a tool with no renderer", () => {
		const component = renderDefaultToolExecution(
			{
				label: "help",
				args: { topic: "x" },
				result: { output: "Tool help not found", isError: true },
				options,
			},
			theme,
		);
		const rows = paint(component);
		expectFramed(rows);
		expect(rows.join("\n")).toContain("Tool help not found");
	});
});
