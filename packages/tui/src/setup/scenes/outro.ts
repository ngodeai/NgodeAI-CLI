import { centerLine, visibleWidth } from "../../utils";
import { padToWidth } from "../../render/utils";
import { gradientLogo, logoNode, NGODE_LOGO } from "../../prompt/welcome";
import { theme } from "../../theme/theme";
import { col, node, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";
import { SETUP_TICK_MS } from "./splash";

export const SETUP_OUTRO_MS = 1200;

const outroMemo = new Memo();

/**
 * Native outro: the shimmering mark, the saved confirmation, and an
 * indeterminate progress bar standing in for the timed sweep. A click sends
 * the `continue` action.
 */
export function describeSetupOutro(): NativeNode {
	const saved = `${theme.status.success} Setup saved`;
	return outroMemo.get([saved], () =>
		col(
			[
				node("spacer", { grow: 1 }),
				logoNode(NGODE_LOGO, true),
				text([span(saved, "success strong")], { wrap: "none" }),
				text([span("Handing off to the normal CLI…", "muted")], { wrap: "none" }),
				node("progress", { value: null, max: { w: "48ch" } }),
				node("spacer", { grow: 1 }),
			],
			{ align: "center", gap: "sm", grow: 1, role: "ngodeai.setup.outro", actions: { click: "continue" } },
		),
	);
}

/**
 * Outro frame: the wordmark inside the same square-dot card the splash and the
 * rest of the UI use, with the confirmation line and a progress rule beneath.
 * No starfield — the card is the frame.
 */
export function renderSetupOutro(width: number, height: number, elapsedMs: number): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_OUTRO_MS));
	const logo = gradientLogo(NGODE_LOGO, progress * 1.2, { pos: (progress * 2) % 1, strength: 1 - progress });
	const title = theme.fg("success", `${theme.status.success} Setup saved`);
	const subtitle = theme.fg("muted", "Handing off to the normal CLI…");
	const logoWidth = Math.max(...logo.map(line => visibleWidth(line)), 0);
	const cardWidth = Math.min(w - 4, Math.max(logoWidth, 44) + 6);
	const innerWidth = Math.max(0, cardWidth - 2);
	const cardLeft = Math.floor((w - cardWidth) / 2);
	const content = [...logo, "", title, subtitle, ""];
	const cardHeight = content.length + 4;
	const cardTop = Math.max(1, Math.floor((h - cardHeight) / 2));

	const padCenter = (text: string): string => {
		const offset = Math.max(0, Math.floor((innerWidth - visibleWidth(text)) / 2));
		return " ".repeat(offset) + text + " ".repeat(Math.max(0, innerWidth - offset - visibleWidth(text)));
	};
	const edge = (glyph: string, fill: string): string =>
		" ".repeat(cardLeft) +
		theme.fg("accent", glyph) +
		theme.fg("border", fill.repeat(innerWidth)) +
		theme.fg("accent", glyph) +
		" ".repeat(Math.max(0, w - cardLeft - cardWidth));

	const sweepWidth = Math.max(1, Math.min(innerWidth, Math.floor(innerWidth * progress)));
	const sweep =
		theme.fg("accent", "━".repeat(sweepWidth)) + theme.fg("dim", "─".repeat(Math.max(0, innerWidth - sweepWidth)));

	const lines: string[] = [];
	for (let y = 0; y < h; y++) {
		if (y < cardTop || y >= cardTop + cardHeight) {
			lines.push(" ".repeat(w));
			continue;
		}
		const row = y - cardTop;
		if (row === 0) {
			lines.push(edge("▪", "─"));
			continue;
		}
		if (row === cardHeight - 1) {
			lines.push(edge("▪", "─"));
			continue;
		}
		const item = content[row - 2];
		const body = item === undefined ? " ".repeat(innerWidth) : padCenter(item);
		lines.push(
			" ".repeat(cardLeft) +
				theme.fg("border", "│") +
				body +
				theme.fg("border", "│") +
				" ".repeat(Math.max(0, w - cardLeft - cardWidth)),
		);
	}

	// Progress rule on the row just inside the bottom edge.
	const sweepRow = cardTop + cardHeight - 2;
	if (sweepRow > cardTop && sweepRow < h) {
		lines[sweepRow] =
			" ".repeat(cardLeft) +
			theme.fg("border", "│") +
			sweep +
			theme.fg("border", "│") +
			" ".repeat(Math.max(0, w - cardLeft - cardWidth));
	}

	return lines;
}
