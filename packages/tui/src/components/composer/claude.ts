/**
 * NgodeAI composer: the Claude Code silhouette — a prompt rule above, a closing
 * rule below, a `❯ ` gutter, and the status chip riding the top rule — drawn in
 * the brand's square-dot frame.
 *
 * The rules end in `▪` at both edges rather than running to the terminal edge,
 * so the input reads as the same card as the welcome banner, the status sidebar,
 * and the setup screens. It stays a two-rule composer: no side borders, no
 * rounded corners, nothing that would make the prompt look boxed in.
 *
 * The right status group rides the top rule as a chip near the right edge
 * (`─────── hi ─▪`); the left group renders as a plain standalone bottom bar
 * that yields its row to the autocomplete menu.
 */

import { visibleWidth, truncateToWidth } from "../../utils";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

/** Square dot at both ends of a rule. */
const DOT = "▪";

/**
 * A full-width rule whose ends are square dots, with an optional status chip
 * docked against the right dot.
 *
 * The chip is right-aligned rather than left-aligned: it is a trailing readout
 * (model, context, spend), and putting it beside the closing dot keeps the
 * prompt itself on the left where the eye starts.
 */
function renderDotRule(ctx: ComposerChromeContext, withChip: boolean): string {
	const { width, borderColor, accentColor, topBorder } = ctx;
	if (width <= 0) return "";
	// Two dots plus at least one rule cell between them.
	if (width < 3) return borderColor("─".repeat(width));

	const inner = width - 2;
	const dot = accentColor(DOT);
	if (!withChip || !topBorder || topBorder.width <= 0) {
		return dot + borderColor("─".repeat(inner)) + dot;
	}

	let { content, width: chipWidth } = topBorder;
	// Leave one rule cell on each side of the chip so it never touches a dot.
	const room = Math.max(0, inner - 2);
	if (chipWidth > room) {
		content = truncateToWidth(content, room);
		chipWidth = visibleWidth(content);
	}
	const fill = Math.max(0, inner - chipWidth - 1);
	return dot + borderColor("─".repeat(fill)) + content + borderColor("─") + dot;
}

export const claudeComposerStyle: ComposerStyle = {
	id: "claude",
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	bottomBarGap: false,
	defaultPromptGutter: "❯ ",

	defaultPaddingX(): number {
		return 0;
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX;
	},

	renderTop(ctx: ComposerChromeContext): string {
		return renderDotRule(ctx, true);
	},

	renderRow(ctx: ComposerRowContext): string[] {
		return [ctx.gutter + ctx.text + ctx.pad];
	},

	renderBottom(ctx: ComposerChromeContext): string {
		return renderDotRule(ctx, false);
	},
};
