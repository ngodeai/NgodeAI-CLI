import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@ngodeai/ngodetype";
import type * as TypeBox from "@ngodeai/ngodetype/typebox";
import * as zod from "@ngodeai/ngodetype/zod";
import * as piCodingAgent from "@ngodeai/coding-agent";
import { GreenCommand } from "@ngodeai/coding-agent/extensibility/custom-commands/bundled/ci-green";
import type { CustomCommandAPI } from "@ngodeai/coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@ngodeai/coding-agent/extensibility/hooks/types";
import type { VcsGitRepo } from "@ngodeai/natives";
import * as vcs from "@ngodeai/natives/vcs";

afterEach(() => {
	vi.restoreAllMocks();
});

function createApi(): CustomCommandAPI {
	return {
		cwd: "/tmp/test",
		exec: async () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		}),
		typebox: {} as unknown as typeof TypeBox,
		arktype: Object.assign(Function.prototype.bind.call(type, undefined) as typeof type, type, { type }),
		zod,
		pi: piCodingAgent,
	};
}

describe("GreenCommand", () => {
	it("includes tag instructions when HEAD has a tag", async () => {
		vi.spyOn(vcs, "requireGit").mockReturnValue({
			tagsAt: async () => ["v0.1.0-alpha2"],
		} as unknown as VcsGitRepo);
		const command = new GreenCommand(createApi());

		const result = await command.execute([], {} as HookCommandContext);

		expect(result).toContain("v0.1.0-alpha2");
	});
});
