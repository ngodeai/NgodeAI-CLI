import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@ngodeai/agent-core";
import { ModelRegistry } from "@ngodeai/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@ngodeai/coding-agent/config/settings";
import { LiveCommandController } from "@ngodeai/coding-agent/modes/controllers/live-command-controller";
import { InteractiveMode } from "@ngodeai/coding-agent/modes/interactive-mode";
import { AgentSession } from "@ngodeai/coding-agent/session/agent-session";
import { AuthStorage } from "@ngodeai/coding-agent/session/auth-storage";
import { SessionManager } from "@ngodeai/coding-agent/session/session-manager";
import { STTController } from "@ngodeai/coding-agent/stt";
import { cfgSttEnabled } from "@ngodeai/coding-agent/stt/settings";
import { initTheme } from "@ngodeai/tui/theme";
import { TempDir } from "@ngodeai/utils";

describe("InteractiveMode live mode vs. composer dictation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-live-dictation-gate-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		cfgSttEnabled.override(settings, true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("refuses live mode while a microphone click is still loading the recognizer", async () => {
		const pendingStart = Promise.withResolvers<void>();
		// The controller stays `idle` until the recognizer finishes loading.
		vi.spyOn(STTController.prototype, "start").mockReturnValue(pendingStart.promise);
		const liveCommand = vi.spyOn(LiveCommandController.prototype, "handleCommand").mockResolvedValue(undefined);
		const showWarning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});

		await mode.handleLiveCommand();
		expect(liveCommand).toHaveBeenCalledTimes(1);

		mode.editor.onToggleDictation?.();
		await mode.handleLiveCommand();

		expect(liveCommand).toHaveBeenCalledTimes(1);
		expect(showWarning).toHaveBeenCalledWith("Finish the current speech-to-text capture before starting live mode.");
		pendingStart.resolve();
	});
});
