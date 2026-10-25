import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@ngodeai/catalog/models";
import { PROVIDER_DESCRIPTORS } from "@ngodeai/catalog/provider-models/descriptors";
import { NGODEAI_GATEWAY_BASE_URL, ngodeaiModelManagerOptions } from "@ngodeai/catalog/provider-models/openai-compat";
import type { FetchImpl } from "@ngodeai/catalog/types";

/** One gateway row, in the shape the real endpoint returns. */
function gatewayRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "ngodeai/deepseek-v4-flash",
		object: "model",
		owned_by: "ngodeai",
		display_name: "DeepSeek V4 Flash",
		context_length: 1048576,
		max_output_tokens: 65536,
		supports_vision: true,
		pricing: { input: 150, output: 300, cache_read: 30, cache_write: 188, currency: "IDR" },
		...overrides,
	};
}

function fetchOnce(rows: readonly unknown[]): { fetch: FetchImpl; calls: string[] } {
	const calls: string[] = [];
	const fetch: FetchImpl = async input => {
		calls.push(String(input));
		return new Response(JSON.stringify({ object: "list", data: rows }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch, calls };
}

describe("NgodeAI provider", () => {
	/**
	 * The gateway is only reachable if the provider has a model-manager factory:
	 * PROVIDER_DESCRIPTORS drops entries without one, and an entry outside that
	 * list is never asked to discover.
	 */
	test("is registered as a discoverable provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(entry => entry.providerId === "ngodeai");
		expect(descriptor).toBeDefined();
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["NGODEAI_API_KEY"]);
	});

	/**
	 * No seed rows. A bundled fallback row is indistinguishable from a real one
	 * in the picker, so a failed fetch must show an empty list, not a plausible
	 * model the account may not be able to select.
	 */
	test("bundles no fallback rows", () => {
		expect(getBundledModels("ngodeai")).toEqual([]);
	});

	test("discovers models from the gateway /v1/models endpoint", async () => {
		const { fetch, calls } = fetchOnce([gatewayRow()]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([`${NGODEAI_GATEWAY_BASE_URL}/models`]);
		expect(models?.map(model => model.id)).toEqual(["ngodeai/deepseek-v4-flash"]);
	});

	/** The generic OpenAI mapper drops every gateway-specific field. */
	test("maps display name, limits, and vision from the gateway row", async () => {
		const { fetch } = fetchOnce([gatewayRow()]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model).toMatchObject({
			name: "DeepSeek V4 Flash",
			provider: "ngodeai",
			api: "openai-completions",
			contextWindow: 1048576,
			maxTokens: 65536,
			input: ["text", "image"],
		});
	});

	/**
	 * Rates arrive in rupiah. The cost model is USD per million tokens, so a
	 * priced IDR row cannot be expressed: it must read "pricing unknown", never
	 * "free" — which is what a zeroed cost silently becomes.
	 */
	test("reports priced IDR rows as pricing unknown, not free", async () => {
		const { fetch } = fetchOnce([gatewayRow()]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.pricingStatus).toBe("unknown");
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	/** An all-zero rate card is the gateway genuinely saying "free". */
	test("keeps an unpriced IDR row free", async () => {
		const { fetch } = fetchOnce([
			gatewayRow({
				id: "ngodeai/deepseek-v4.1-flash",
				pricing: { input: 0, output: 0, cache_read: 0, cache_write: 0, currency: "IDR" },
			}),
		]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.pricingStatus).toBeUndefined();
	});
});
