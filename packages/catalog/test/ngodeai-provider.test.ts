import { describe, expect, test } from "bun:test";
import { PROVIDER_DESCRIPTORS } from "@ngodeai/catalog/provider-models/descriptors";
import { NGODEAI_GATEWAY_BASE_URL, ngodeaiModelManagerOptions } from "@ngodeai/catalog/provider-models/openai-compat";
import type { FetchImpl } from "@ngodeai/catalog/types";

describe("NgodeAI provider", () => {
	/**
	 * The gateway is only reachable if the provider has a model-manager factory:
	 * PROVIDER_DESCRIPTORS drops entries without one, and an entry that is not in
	 * that list is never asked to discover. Before this test the KDL `discovery`
	 * node existed but nothing consumed it, so the setup model picker showed
	 * "No matching models" right after a successful sign-in.
	 */
	test("is registered as a discoverable provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(entry => entry.providerId === "ngodeai");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("ngodeai/auto");
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["NGODEAI_API_KEY"]);
	});

	test("discovers models from the gateway /v1/models endpoint", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
			return new Response(
				JSON.stringify({
					data: [
						{ id: "ngodeai/auto", object: "model" },
						{ id: "claude-sonnet-4-5", object: "model" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([{ url: `${NGODEAI_GATEWAY_BASE_URL}/models`, authorization: "Bearer ngodeai_live_test" }]);
		expect(models?.map(model => model.id)).toContain("claude-sonnet-4-5");
		expect(models?.every(model => model.provider === "ngodeai")).toBe(true);
	});
});
