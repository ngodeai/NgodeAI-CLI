/**
 * `/sidebar` is the prefix command for the right-hand status pane: it toggles
 * `sidebar.enabled` and sets `sidebar.width`, both of which the TUI applies
 * through the live-settings listener rather than through manual UI plumbing in
 * the handler.
 */
import { describe, expect, it, vi, type Mock } from "bun:test";
// The registry owns the command list and must load first: importing
// `builtin-modes` directly starts a module cycle through it.
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@ngodeai/coding-agent/slash-commands/builtin-registry";
import { Settings } from "@ngodeai/coding-agent/config/settings";
import { cfgSidebarEnabled, cfgSidebarWidth } from "@ngodeai/coding-agent/modes/settings";
import type { TuiSlashCommandRuntime } from "@ngodeai/coding-agent/slash-commands/types";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "@ngodeai/tui/components/sidebar/index";

const registered = BUILTIN_SLASH_COMMANDS_INTERNAL.find(candidate => candidate.name === "sidebar");
if (!registered?.handleTui) throw new Error("Expected a /sidebar TUI handler");
const handleTui = registered.handleTui.bind(registered);

/** Host stubs the handler drives: status/error sinks and the editor draft. */
interface SidebarHarness {
	runtime: TuiSlashCommandRuntime;
	status: Mock<(...args: unknown[]) => void>;
	error: Mock<(...args: unknown[]) => void>;
}

function runtimeFor(settings: Settings): SidebarHarness {
	const status = vi.fn();
	const error = vi.fn();
	const runtime = {
		ctx: {
			settings,
			showStatus: status,
			showError: error,
			editor: { setText: vi.fn() },
		},
	} as unknown as TuiSlashCommandRuntime;
	return { runtime, status, error };
}

function run(args: string, settings: Settings) {
	const { runtime, status, error } = runtimeFor(settings);
	handleTui({ name: "sidebar", args, text: `/sidebar ${args}`.trim() }, runtime);
	return { settings, status, error };
}

describe("/sidebar", () => {
	it("hides the sidebar and brings it back", () => {
		const settings = Settings.isolated();
		expect(cfgSidebarEnabled.get(settings)).toBe(true);

		run("off", settings);
		expect(cfgSidebarEnabled.get(settings)).toBe(false);

		run("on", settings);
		expect(cfgSidebarEnabled.get(settings)).toBe(true);
	});

	it("toggles when given no argument", () => {
		const settings = Settings.isolated();
		run("", settings);
		expect(cfgSidebarEnabled.get(settings)).toBe(false);
		run("toggle", settings);
		expect(cfgSidebarEnabled.get(settings)).toBe(true);
	});

	it("clamps the requested width into the pane's usable range", () => {
		const settings = Settings.isolated();
		run("width 500", settings);
		expect(cfgSidebarWidth.get(settings)).toBe(SIDEBAR_MAX_WIDTH);
		run("width 4", settings);
		expect(cfgSidebarWidth.get(settings)).toBe(SIDEBAR_MIN_WIDTH);
		run("width 30", settings);
		expect(cfgSidebarWidth.get(settings)).toBe(30);
	});

	it("reports state without changing it", () => {
		const settings = Settings.isolated({ "sidebar.enabled": false, "sidebar.width": 30 });
		const { status } = run("status", settings);
		expect(cfgSidebarEnabled.get(settings)).toBe(false);
		expect(status).toHaveBeenCalledWith(expect.stringContaining("off"));
		expect(status).toHaveBeenCalledWith(expect.stringContaining("30 columns"));
	});

	it("rejects an unknown verb and a non-numeric width", () => {
		const settings = Settings.isolated();
		expect(run("sideways", settings).error).toHaveBeenCalled();
		expect(run("width wide", settings).error).toHaveBeenCalled();
		expect(cfgSidebarEnabled.get(settings)).toBe(true);
	});
});
