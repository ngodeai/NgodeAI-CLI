import { centerLine, visibleWidth } from "../../utils";
import { padToWidth } from "../../render/utils";
import { gradientLogo, logoNode, NGODE_LOGO, type ShineConfig } from "../../prompt/welcome";
import { theme } from "../../theme/theme";
import { formatKeyHint } from "../../app-keybindings";
import { col, node, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";

export const SETUP_SPLASH_MS = 2600;
export const SETUP_TICK_MS = 33;

/**
 * Tall variant of the wordmark: rows doubled, columns left alone.
 *
 * Doubling columns as well turns the letters into `NNggooddeeAAII`, which reads
 * as a barcode rather than a name. Height alone gives the mark presence without
 * destroying the glyphs.
 */
const LARGE_LOGO = NGODE_LOGO.flatMap(line => [line, line]);
const LOGO_WIDTH = Math.max(...LARGE_LOGO.map(line => visibleWidth(line)));
const LOGO_HEIGHT = LARGE_LOGO.length;

/** Full scene needs comfortable room; below this we drop to a centered mark. */
const MIN_SCENE_WIDTH = 60;
const MIN_SCENE_HEIGHT = 22;

/**
 * Frame glyphs. The splash draws a single bordered card — square dots at the
 * corners, a hairline rule between them — rather than the old starfield and
 * water. The card is the brand: it is the same box the rest of the UI uses.
 */
const FRAME = {
	topLeft: "▪",
	topRight: "▪",
	bottomLeft: "▪",
	bottomRight: "▪",
	horizontal: "─",
	vertical: "│",
} as const;

/** Tagline under the wordmark; one line, always muted. */
const TAGLINE = "one key, every model";

/** Skip affordance; built at render time so it follows the live symbol preset. */
function skipHint(): string {
	return `press ${formatKeyHint("enter")} to skip`;
}

/** Draw a `width`-wide horizontal rule in the border tone. */
function rule(width: number): string {
	return theme.fg("border", FRAME.horizontal.repeat(Math.max(0, width)));
}

/** One interior row: vertical rules at both edges, `content` padded between. */
function cardRow(content: string, innerWidth: number): string {
	const pad = Math.max(0, innerWidth - visibleWidth(content));
	return theme.fg("border", FRAME.vertical) + content + " ".repeat(pad) + theme.fg("border", FRAME.vertical);
}

/**
 * Animated setup splash: the full **NgodeAI** wordmark rising inside a square-dot
 * card, with a shine sweep travelling across the gradient and a soft pulse on
 * the frame. Everything is composed from the same card the rest of the UI uses,
 * so the first frame already looks like the app rather than a separate scene.
 */
export function renderSetupSplash(width: number, height: number, elapsedMs: number): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_SPLASH_MS));
	const phase = progress * 1.8;
	const shine: ShineConfig = { pos: (progress * 2.5) % 1, strength: Math.max(0, 1 - progress * 0.35) };

	if (w < MIN_SCENE_WIDTH || h < MIN_SCENE_HEIGHT) return renderCompactSplash(w, h, phase, shine);

	// Prefer the 2x mark; fall back to 1x when the terminal cannot hold it with
	// breathing room, so the wordmark never touches the frame.
	const useLarge = LOGO_WIDTH + 10 <= w;
	const mark = useLarge ? LARGE_LOGO : NGODE_LOGO;
	const markWidth = Math.max(...mark.map(line => visibleWidth(line)));
	const markHeight = mark.length;
	const cardWidth = Math.min(w - 4, markWidth + 8);
	const innerWidth = Math.max(0, cardWidth - 2);
	const cardHeight = markHeight + 8;
	const cardLeft = Math.floor((w - cardWidth) / 2);
	const cardTop = Math.max(1, Math.floor((h - cardHeight) / 2));

	const lines: string[] = [];
	for (let y = 0; y < h; y++) {
		if (y < cardTop || y >= cardTop + cardHeight) {
			lines.push(" ".repeat(w));
			continue;
		}
		const rowInCard = y - cardTop;
		if (rowInCard === 0) {
			lines.push(
				" ".repeat(cardLeft) +
					theme.fg("accent", FRAME.topLeft) +
					rule(innerWidth) +
					theme.fg("accent", FRAME.topRight) +
					" ".repeat(Math.max(0, w - cardLeft - cardWidth)),
			);
			continue;
		}
		if (rowInCard === cardHeight - 1) {
			lines.push(
				" ".repeat(cardLeft) +
					theme.fg("accent", FRAME.bottomLeft) +
					rule(innerWidth) +
					theme.fg("accent", FRAME.bottomRight) +
					" ".repeat(Math.max(0, w - cardLeft - cardWidth)),
			);
			continue;
		}

		// Rows 1-2 are padding, then the mark, then the tagline, then padding.
		const markRow = rowInCard - 1 - 2;
		let content: string;
		if (markRow >= 0 && markRow < markHeight) {
			const gradientRow = gradientLogo(mark, phase, shine)[markRow] ?? "";
			const offset = Math.max(0, Math.floor((innerWidth - visibleWidth(gradientRow)) / 2));
			content =
				" ".repeat(offset) + gradientRow + " ".repeat(Math.max(0, innerWidth - offset - visibleWidth(gradientRow)));
		} else if (markRow === markHeight) {
			const offset = Math.max(0, Math.floor((innerWidth - TAGLINE.length) / 2));
			content =
				" ".repeat(offset) +
				theme.fg("muted", TAGLINE) +
				" ".repeat(Math.max(0, innerWidth - offset - TAGLINE.length));
		} else {
			content = " ".repeat(innerWidth);
		}
		lines.push(
			" ".repeat(cardLeft) + cardRow(content, innerWidth) + " ".repeat(Math.max(0, w - cardLeft - cardWidth)),
		);
	}

	// Skip hint on a cleared strip at the bottom so it stays legible.
	const hint = skipHint();
	const hintStart = Math.floor((w - visibleWidth(hint)) / 2);
	lines[h - 1] =
		" ".repeat(Math.max(0, hintStart)) +
		theme.fg("dim", hint) +
		" ".repeat(Math.max(0, w - hintStart - visibleWidth(hint)));

	return lines;
}

const splashMemo = new Memo();

/**
 * Native splash: the wordmark inside the same square-dot card, with the
 * terminal-clocked shimmer on the mark and the skip hint pinned to the bottom.
 */
export function describeSetupSplash(): NativeNode {
	const hint = skipHint();
	return splashMemo.get([hint], () =>
		col(
			[
				node("spacer", { grow: 1 }),
				logoNode(LARGE_LOGO, true),
				text([span(TAGLINE, "muted")], { wrap: "none" }),
				node("spacer", { grow: 1 }),
				text([span(hint, "dim")], { wrap: "none" }),
			],
			{ align: "center", gap: "md", grow: 1, role: "ngodeai.setup.splash", actions: { click: "skip" } },
		),
	);
}

/** Centered fallback for windows too small to hold the full card. */
function renderCompactSplash(width: number, height: number, phase: number, shine: ShineConfig): string[] {
	const art = height >= 14 ? LARGE_LOGO : NGODE_LOGO;
	const content = [...gradientLogo(art, phase, shine), "", theme.fg("muted", TAGLINE)];
	const start = Math.max(0, Math.floor((height - content.length) / 2));
	const lines: string[] = [];
	for (let y = 0; y < height; y++) {
		const item = content[y - start];
		lines.push(width > 0 ? padToWidth(item !== undefined ? centerLine(item, width) : "", width) : "");
	}
	if (height > 2)
		lines[height - 2] = width > 0 ? padToWidth(centerLine(theme.fg("dim", skipHint()), width), width) : "";
	return lines;
}
