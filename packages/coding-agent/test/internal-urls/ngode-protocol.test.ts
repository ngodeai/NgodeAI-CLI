import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { InternalUrlRouter } from "@ngodeai/coding-agent/internal-urls";
import { getDocsDiskRoot } from "@ngodeai/coding-agent/internal-urls/docs-index";

describe("NgodeProtocolHandler", () => {
	it("treats ngodeai://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("ngodeai://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("ngodeai://tools/read.md");
		const prefixed = await router.resolve("ngodeai://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});

	it("locates a doc to the file the active corpus was read from", async () => {
		const router = InternalUrlRouter.instance();
		// A source checkout reads docs from disk; a bundled or embedded corpus
		// (e.g. after `gen:bundle`) has no file and must never link.
		const root = getDocsDiskRoot();
		const onDisk = root === null ? undefined : path.join(root, "tools", "read.md");

		// Both renderer entry points (sync read cards, async markdown links) must
		// agree on the file, or a link opens a doc `read` never resolved.
		expect(router.locateSync("ngodeai://tools/read.md")).toBe(onDisk);
		expect(router.locateSync("ngodeai://docs/tools/read.md:1-20")).toBe(onDisk);
		expect(await router.locate("ngodeai://tools/read.md")).toBe(onDisk ?? null);
	});

	it("never locates a URL that names no doc on disk", async () => {
		const router = InternalUrlRouter.instance();

		// The docs root is a listing, and an unknown doc has no file: linking it
		// would open something `ngodeai://` does not serve.
		expect(router.locateSync("ngodeai://")).toBeUndefined();
		expect(router.locateSync("ngodeai://docs")).toBeUndefined();
		expect(router.locateSync("ngodeai://no-such-doc.md")).toBeUndefined();
		expect(await router.locate("ngodeai://no-such-doc.md")).toBeNull();

		// Render paths must survive a model-authored traversal URL.
		expect(router.locateSync("ngodeai://../AGENTS.md")).toBeUndefined();
	});
});
