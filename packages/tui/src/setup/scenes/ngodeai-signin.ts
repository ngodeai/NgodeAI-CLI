/**
 * First-run NgodeAI connect scene.
 *
 * Runs before the generic provider roster on a fresh install. This build ships
 * pointed at the first-party gateway (`https://llm.ngodeai.net/v1`), so the
 * first thing a new user needs is a key from ngodeai.net — not a menu of twenty
 * third-party OAuth flows.
 *
 * Two states:
 *   1. **Account** — what the key is, the ngodeai.net link, and how to continue.
 *   2. **Key** — one masked field for `ngodeai_live_…`.
 *
 * Saving goes through `AuthStorage.oauth.login` with the same api-key login
 * flow `/login` uses, so the credential this writes is byte-for-byte what a key
 * pasted later would produce (including the `/models` validation the KDL rule
 * declares).
 */
import type { AuthStorage } from "@ngodeai/ai";
import { Container } from "../../tui";
import { Spacer } from "../../components/spacer";
import { Text } from "../../components/text";
import { Input } from "../../components/input";
import { WizardStep } from "../../components/wizard-step";
import { editorKey } from "../../chrome/keybinding-hints";
import { matchesKey } from "../../keys";
import { theme } from "../../theme/theme";
import { col, span, text } from "../../native/describe";
import type { NativeChild, NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";
import type { SetupScene, SetupSceneController, SetupSceneHost, StyledLine } from "./types";

/** Where a new account is created. */
export const NGODEAI_SIGNUP_URL = "https://ngodeai.net";

/** Gateway the key is validated against and the CLI talks to. */
export const NGODEAI_GATEWAY_URL = "https://llm.ngodeai.net/v1";

/** Prefix every issued key carries; used to reject obvious typos before a round-trip. */
export const NGODEAI_KEY_PREFIX = "ngodeai_live_";

/** Provider id this scene writes credentials for (matches `auth/ngodeai.kdl`). */
const PROVIDER_ID = "ngodeai";

type Phase = "account" | "key" | "saving" | "done";

class NgodeaiSignInController implements SetupSceneController {
	readonly title = "Connect your NgodeAI account";
	get subtitle(): string {
		return `One key for every model, served from ${NGODEAI_GATEWAY_URL.replace("https://", "")}`;
	}

	#phase: Phase = "account";
	readonly #input: Input;
	#status: StyledLine | undefined;
	#step: WizardStep | undefined;
	readonly #native = new Memo();
	#disposed = false;
	#abort: AbortController | undefined;

	readonly #host: SetupSceneHost;
	readonly #authStorage: AuthStorage;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#authStorage = host.ctx.authStorage;
		this.#input = new Input();
		this.#input.placeholder = `${NGODEAI_KEY_PREFIX}...`;
		this.#input.mask = true;
	}

	async onMount(): Promise<void> {
		// Already configured: don't make an existing user re-paste their key.
		if (await this.#hasKey()) {
			this.#host.finish("skipped");
			return;
		}
		this.#host.requestRender();
	}

	dispose(): void {
		this.#disposed = true;
		this.#abort?.abort();
	}

	invalidate(): void {
		this.#native.clear();
		this.#step?.invalidate();
		this.#input.invalidate();
	}

	handleInput(data: string): void {
		if (this.#phase === "saving" || this.#phase === "done") return;
		if (this.#phase === "account") {
			if (matchesKey(data, "enter")) {
				this.#phase = "key";
				this.#status = undefined;
				this.#host.requestRender();
				return;
			}
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.#host.finish("skipped");
			}
			return;
		}
		if (matchesKey(data, "escape")) {
			this.#phase = "account";
			this.#status = undefined;
			this.#host.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			void this.#save();
			return;
		}
		this.#input.handleInput(data);
		this.#host.requestRender();
	}

	async #save(): Promise<void> {
		const value = this.#input.getValue().trim();
		if (value.length === 0) {
			this.#status = { text: "Paste a key first.", color: "warning" };
			this.#host.requestRender();
			return;
		}
		if (!value.startsWith(NGODEAI_KEY_PREFIX)) {
			this.#status = {
				text: `NgodeAI keys start with ${NGODEAI_KEY_PREFIX}`,
				color: "warning",
			};
			this.#host.requestRender();
			return;
		}

		this.#phase = "saving";
		this.#status = { text: "Verifying key…", color: "muted" };
		this.#host.requestRender();

		this.#abort = new AbortController();
		try {
			// The api-key login flow feeds the pasted text through its code path,
			// validates it against the rule's `/models` URL, and persists it.
			await this.#authStorage.oauth.login(PROVIDER_ID as never, {
				signal: this.#abort.signal,
				onAuth: () => {},
				onPrompt: async () => value,
			});
			if (this.#disposed) return;
			// Pull the gateway's real model list before handing off. The api-key
			// login validates against /v1/models but discards the response, so
			// without this the next scene opens with only the bundled seed rows —
			// and if the bundle predates the provider, with nothing at all.
			this.#status = { text: "Loading models…", color: "muted" };
			this.#host.requestRender();
			try {
				await this.#host.ctx.refreshProvider(PROVIDER_ID);
			} catch {
				// A discovery failure must not strand the user on this step: the
				// key is already saved, and the model scene refreshes again.
			}
			if (this.#disposed) return;
			this.#phase = "done";
			this.#status = { text: "Key verified and saved. NgodeAI is ready.", color: "success" };
			this.#host.requestRender();
			setTimeout(() => {
				if (!this.#disposed) this.#host.finish("done");
			}, 600);
		} catch (error) {
			if (this.#disposed) return;
			this.#phase = "key";
			this.#status = {
				text: `Could not verify the key: ${error instanceof Error ? error.message : String(error)}`,
				color: "error",
			};
			this.#host.requestRender();
		}
	}

	async #hasKey(): Promise<boolean> {
		try {
			if (Bun.env.NGODEAI_API_KEY?.trim()) return true;
			return (await this.#authStorage.keys.peek(PROVIDER_ID)) !== undefined;
		} catch {
			return false;
		}
	}

	render(width: number, maxLines?: number): readonly string[] {
		const content = this.#renderContent();
		const step = (this.#step ??= new WizardStep({ kind: "choice", content }));
		step.setHeading(undefined);
		step.setIntro(this.#renderIntro());
		step.setContent(content);
		step.setStatus(this.#status ? new Text(this.#status.text, 0, 0) : undefined);
		step.setMaxHeight(maxLines);
		return step.render(width);
	}

	#renderIntro(): Container | undefined {
		if (this.#phase !== "account") return undefined;
		const intro = new Container();
		intro.addChild(
			new Text(
				theme.fg(
					"muted",
					"Your NgodeAI key unlocks the hosted gateway: one credential for every model, no per-provider setup.",
				),
				0,
				0,
			),
		);
		intro.addChild(new Spacer(1));
		return intro;
	}

	#renderContent(): Container {
		const box = new Container();
		if (this.#phase === "account") {
			box.addChild(new Text(theme.fg("accent", `Create an account at ${NGODEAI_SIGNUP_URL}`), 0, 0));
			box.addChild(new Spacer(1));
			box.addChild(new Text(theme.fg("dim", "Free to start. Your key is shown once, right after sign-up."), 0, 0));
			box.addChild(new Spacer(1));
			box.addChild(new Text(`${theme.fg("accent", "enter")} ${theme.fg("muted", "I already have a key")}`, 0, 0));
			box.addChild(
				new Text(
					`${theme.fg("accent", editorKey("tui.select.cancel"))} ${theme.fg("muted", "Skip — configure a provider later")}`,
					0,
					0,
				),
			);
			return box;
		}

		box.addChild(new Text(theme.fg("muted", "Paste the key from your NgodeAI dashboard:"), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(this.#input);
		box.addChild(new Spacer(1));
		box.addChild(
			new Text(
				`${theme.fg("accent", "enter")} ${theme.fg("muted", "save")}   ${theme.fg("accent", "esc")} ${theme.fg("muted", "back")}`,
				0,
				0,
			),
		);
		return box;
	}

	describe(): NativeNode {
		const phase = this.#phase;
		const status = this.#status;
		return this.#native.get([phase, status, this.#input], () => {
			const children: NativeChild[] = [
				text([span(`Create an account at ${NGODEAI_SIGNUP_URL}`, "accent link", { href: NGODEAI_SIGNUP_URL })], {
					wrap: "char",
				}),
			];
			if (phase !== "account") {
				children.push(text([span("Paste your NgodeAI API key", "muted")]));
				children.push(this.#input);
			}
			if (status) children.push(text([span(status.text, status.color)]));
			return col(children, { gap: "sm", role: "ngodeai.setup.connect" });
		});
	}
}

/**
 * Scene descriptor.
 *
 * `minVersion: 1` matches the generic provider scene: both run on a fresh
 * install (stored version 0) and neither re-runs once setup is marked complete
 * at version 2. The `shouldRun` gate then narrows it further to installs that
 * genuinely have no key yet, so an upgrade with working credentials skips it.
 */
export const ngodeaiSignInScene: SetupScene = {
	id: "ngodeai-signin",
	title: "Connect your NgodeAI account",
	minVersion: 1,
	shouldRun: async ctx => {
		try {
			if (Bun.env.NGODEAI_API_KEY?.trim()) return false;
			return (await ctx.authStorage.keys.peek(PROVIDER_ID)) === undefined;
		} catch {
			return true;
		}
	},
	mount: host => new NgodeaiSignInController(host),
};
