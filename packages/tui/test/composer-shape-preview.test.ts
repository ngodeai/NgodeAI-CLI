import { beforeAll, describe, expect, it } from "bun:test";
import { renderComposerShapePreview } from "../src/overlays/composer-shape-preview";
import { getComposerShapeOptions, installExtensionComposerShape } from "../src/overlays/composer-shape-registry";
import { initTheme, setTheme } from "../src/theme/theme";
import { type ComposerStyle, visibleWidth } from "../src/index";

beforeAll(async () => {
	await initTheme();
});

describe("composer shape preview", () => {
	it("resolves transparent composer preview text away from the terminal default", async () => {
		// The built-in `light` theme leaves `text` empty; a transparent shape must
		// still emit an explicit contrast foreground instead of ESC[39m, matching
		// the live editor so the preview stays readable on a light terminal.
		await setTheme("light");
		const box = renderComposerShapePreview("box", 80).join("\n");
		expect(box).not.toContain("\x1b[39mAsk anything");
		expect(box).toMatch(/\x1b\[38[;0-9]*mAsk anything/);
	});

	it("borrows status rows from the live status source", async () => {
		await setTheme("dark");
		// Echo mocks: the stand-in title must be forwarded as a prop to the
		// title-bearing status call, not glued onto the rendered content.
		const status = {
			getTopBorder: (_width: number, previewTitle?: string) => {
				const content = `TOPBAR ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			getStandaloneTopBorder: (_width: number, previewTitle?: string) => {
				const content = `CHIP ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			getBandTopBorder: (_width: number, previewTitle?: string) => {
				const content = `BAND ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			renderBottomBar: (_width: number, groups: "left" | "full", previewTitle?: string) =>
				`BOTTOM-${groups.toUpperCase()} ${previewTitle ?? ""}`,
		};

		// This build ships one shape. Its right group chips onto the top rule and
		// its left group rides a standalone bottom bar.
		const claude = renderComposerShapePreview("claude", 80, status).join("\n");
		expect(claude).toContain("CHIP");
		expect(claude).toContain("ngodeai");
		expect(claude).toContain("BOTTOM-LEFT");
		// The box style stays available for bare editors and embeds its status.
		const box = renderComposerShapePreview("box", 80, status).join("\n");
		expect(box).toContain("TOPBAR");
		expect(box).not.toContain("BOTTOM");
	});

	it("installs extension shapes into both selectors and live rendering", async () => {
		await setTheme("dark");
		const style: ComposerStyle = {
			id: "extension-dock",
			sideBorders: false,
			verticalChrome: 1,
			statusAttachment: "none",
			bottomBar: "full",
			bottomBarGap: false,
			defaultPromptGutter: "EXT ",
			defaultPaddingX: () => 0,
			sideChromeWidth: () => 0,
			renderTop: context => context.borderColor("=".repeat(context.width)),
			renderRow: context => [context.gutter + context.text + context.pad],
			renderBottom: () => undefined,
		};
		const dispose = installExtensionComposerShape({
			label: "Extension Dock",
			description: "Custom extension composer",
			style,
		});

		try {
			expect(getComposerShapeOptions().at(-1)).toEqual({
				value: "extension-dock",
				label: "Extension Dock",
				description: "Custom extension composer",
			});
			const rendered = renderComposerShapePreview("extension-dock", 76).join("\n");
			expect(rendered).toContain("=".repeat(76));
			expect(rendered).toContain("EXT ");
			expect(rendered).toContain("Ask anything");
		} finally {
			dispose();
		}

		expect(getComposerShapeOptions().some(option => option.value === "extension-dock")).toBe(false);
	});

	it("uses the full overlay width instead of clipping the status chip (issue #12500)", async () => {
		await setTheme("dark");
		const status = {
			getTopBorder: (width: number) => ({ content: "", width }),
			getStandaloneTopBorder: (width: number) => ({ content: "STATUS", width: 6 }),
			getBandTopBorder: (width: number) => ({ content: "", width }),
			renderBottomBar: () => "",
		};

		const [topRule] = renderComposerShapePreview("claude", 200, status);

		// The rule spans the whole width, with the chip docked before the right dot.
		const plainRule = Bun.stripANSI(topRule ?? "");
		expect(visibleWidth(topRule ?? "")).toBe(200);
		expect(plainRule).toContain("STATUS");
		expect(plainRule.endsWith("▪")).toBe(true);
	});
});
