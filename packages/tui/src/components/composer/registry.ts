import { boxComposerStyle } from "./box";
import { claudeComposerStyle } from "./claude";
import type { ComposerStyle, EditorBorderStyle } from "./types";

/**
 * Built-in composer styles.
 *
 * One, deliberately. The prompt is a fixed part of the product's identity, not
 * a preference: a single silhouette is what makes every screenshot, every
 * theme, and every terminal look like NgodeAI. Extensions may still register
 * their own; nothing ships in the box but `claude`.
 */
const BUILTIN_COMPOSER_STYLES: Readonly<Record<string, ComposerStyle>> = {
	claude: claudeComposerStyle,
	// Not selectable: the fallback for a bare Editor with no status line.
	box: boxComposerStyle,
};
const extensionComposerStyles = new Map<string, ComposerStyle>();

/** Whether an id names a composer style shipped by the package. */
export function isBuiltinComposerStyle(id: string): boolean {
	return Object.hasOwn(BUILTIN_COMPOSER_STYLES, id);
}

/**
 * Whether a style paints its own row foreground.
 *
 * Extensions registered before `filledSurface` existed received undecorated
 * row text, so an omitted flag remains filled for extension-owned ids.
 */
export function isFilledComposerStyle(style: ComposerStyle): boolean {
	return style.filledSurface ?? !isBuiltinComposerStyle(style.id);
}

/**
 * Register one extension-owned composer style for this process.
 *
 * Built-in ids and duplicate extension ids are rejected. The returned disposer
 * removes only this registration.
 */
export function registerComposerStyle(style: ComposerStyle): () => void {
	const id = style.id.trim();
	if (id.length === 0 || id !== style.id) throw new TypeError("Composer style id must be a non-empty trimmed string");
	if (isBuiltinComposerStyle(id)) throw new Error(`Cannot replace built-in composer style "${id}"`);
	if (extensionComposerStyles.has(id)) throw new Error(`Composer style "${id}" is already registered`);
	extensionComposerStyles.set(id, style);
	return () => {
		if (extensionComposerStyles.get(id) === style) extensionComposerStyles.delete(id);
	};
}

/**
 * Style object for a composer shape.
 *
 * Unknown ids — including every shape this package used to ship — fall back to
 * the one built-in style, so a settings file written before the trim keeps
 * working instead of rendering an unstyled prompt.
 */
export function getComposerStyle(id: EditorBorderStyle): ComposerStyle {
	return extensionComposerStyles.get(id) ?? BUILTIN_COMPOSER_STYLES[id] ?? claudeComposerStyle;
}
