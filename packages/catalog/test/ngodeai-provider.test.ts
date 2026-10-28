import { describe, expect, test } from "bun:test";
import { buildModel } from "@ngodeai/catalog/build";
import { calculateCost, getBundledModels } from "@ngodeai/catalog/models";
import { PROVIDER_DESCRIPTORS } from "@ngodeai/catalog/provider-models/descriptors";
import {
	isNgodeaiDecisionRow,
	NGODEAI_GATEWAY_BASE_URL,
	ngodeaiDecisionsBaseUrl,
	ngodeaiModelManagerOptions,
} from "@ngodeai/catalog/provider-models/openai-compat";
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
		pricing_usd: {
			input: 0.008293,
			output: 0.016586,
			cache_read: 0.001659,
			cache_write: 0.010394,
			unit: "per_1m_tokens",
			currency: "USD",
		},
		...overrides,
	};
}

/** One decision row, in the shape the real gateway returns for Jev. */
function decisionRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "ngodeai/jev-1.14.0",
		object: "model",
		owned_by: "ngodeai",
		display_name: "Jev 1.14.0",
		description: "Decision model that answers typed questions about a state with calibrated probabilities.",
		category: "decision",
		status: "active",
		endpoint: "/v1/systemone",
		route_tier: "vip",
		context_length: 32768,
		max_output_tokens: 0,
		supports_vision: false,
		pricing: { input: 708, output: 0, cache_read: 0, cache_write: 0, currency: "IDR" },
		pricing_usd: {
			input: 0.039137,
			output: 0,
			cache_read: 0,
			cache_write: 0,
			unit: "per_1m_tokens",
			currency: "USD",
		},
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
		// The gateway prefixes roster ids with its own provider. The catalog stores
		// the bare id with the provider alongside it, so the selector built from
		// this row is `ngodeai/deepseek-v4-flash`, not `ngodeai/ngodeai/...`.
		expect(models?.map(model => model.id)).toEqual(["deepseek-v4-flash"]);
		expect(models?.[0]?.requestModelId).toBe("ngodeai/deepseek-v4-flash");
	});

	/** A decision row keeps the wire id in `requestModelId` for the same reason. */
	test("stores the gateway prefix as the wire id, not as the catalog id", async () => {
		const { fetch } = fetchOnce([decisionRow({ id: "ngodeai/jev-1.14", display_name: "Jev 1.14" })]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.id).toBe("jev-1.14");
		expect(model.requestModelId).toBe("ngodeai/jev-1.14");
		expect(model.kind).toBe("judge");
		expect(model.api).toBe("typesafe");
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

	/** `pricing_usd` is the rate card the cost model can actually express. */
	test("maps the USD rate card", async () => {
		const { fetch } = fetchOnce([gatewayRow()]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.cost).toEqual({
			input: 0.008293,
			output: 0.016586,
			cacheRead: 0.001659,
			cacheWrite: 0.010394,
		});
		expect(model.pricingStatus).toBeUndefined();
	});

	/** A priced IDR card with no USD counterpart is real but unrepresentable. */
	test("reports a priced row with no USD card as pricing unknown, not free", async () => {
		const { fetch } = fetchOnce([gatewayRow({ pricing_usd: undefined })]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.pricingStatus).toBe("unknown");
	});

	/** An all-zero rate card is the gateway genuinely saying "free". */
	test("keeps an unpriced row free", async () => {
		const { fetch } = fetchOnce([
			gatewayRow({
				id: "ngodeai/deepseek-v4.1-flash",
				pricing: { input: 0, output: 0, cache_read: 0, cache_write: 0, currency: "IDR" },
				pricing_usd: {
					input: 0,
					output: 0,
					cache_read: 0,
					cache_write: 0,
					unit: "per_1m_tokens",
					currency: "USD",
				},
			}),
		]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.pricingStatus).toBeUndefined();
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	/** A mislabelled unit must not be silently rescaled. */
	test("ignores a USD card whose unit is not per-million", async () => {
		const { fetch } = fetchOnce([
			gatewayRow({
				pricing_usd: {
					input: 8.293,
					output: 16.586,
					cache_read: 1.659,
					cache_write: 10.394,
					unit: "per_1k_tokens",
					currency: "USD",
				},
			}),
		]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.pricingStatus).toBe("unknown");
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	/**
	 * The gateway publishes chat and decision models in one roster. A decision
	 * row is not a chat model: it answers typed questions on `/v1/systemone` and
	 * returns calibrated probabilities. Mapping it as `openai-completions` made
	 * every decision fall back to prompted keywords with one-hot confidence,
	 * which is exactly the uncertainty the decision layer needs to read.
	 */
	test("maps a decision row to the native judgment transport", async () => {
		const { fetch } = fetchOnce([decisionRow()]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.api).toBe("typesafe");
		expect(model.kind).toBe("judge");
		// System One is a sibling of `/v1`, not a child of it.
		expect(model.baseUrl).toBe("https://llm.ngodeai.net");
		// A judgment returns a typed answer, never a tool call, and reads text only.
		expect(model.supportsTools).toBe(false);
		expect(model.input).toEqual(["text"]);
	});

	test("keeps chat rows on the chat transport", async () => {
		const { fetch } = fetchOnce([gatewayRow()]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.api).toBe("openai-completions");
		expect(model.kind).toBeUndefined();
		expect(model.baseUrl).toBe(NGODEAI_GATEWAY_BASE_URL);
	});

	test("carries the decision row's price and context window", async () => {
		const { fetch } = fetchOnce([decisionRow()]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.contextWindow).toBe(32768);
		// Jev bills input only.
		expect(model.cost?.input).toBeCloseTo(0.039137, 6);
		expect(model.cost?.output).toBe(0);
	});

	test("recognises a decision row by category or by endpoint", () => {
		expect(isNgodeaiDecisionRow({ category: "decision" })).toBe(true);
		expect(isNgodeaiDecisionRow({ endpoint: "/v1/systemone" })).toBe(true);
		expect(isNgodeaiDecisionRow({ category: "coding", endpoint: "/v1/chat/completions" })).toBe(false);
		expect(isNgodeaiDecisionRow({})).toBe(false);
	});

	test("derives the System One root from a custom gateway base", () => {
		expect(ngodeaiDecisionsBaseUrl("https://llm.ngodeai.net/v1")).toBe("https://llm.ngodeai.net");
		expect(ngodeaiDecisionsBaseUrl("https://llm.ngodeai.net/v1/")).toBe("https://llm.ngodeai.net");
		// A base without the /v1 segment is already a root.
		expect(ngodeaiDecisionsBaseUrl("https://gateway.internal")).toBe("https://gateway.internal");
	});

	/**
	 * The gateway serves a free decision model beside the paid one. The price
	 * distinction has to survive into the catalog: a picker that shows both as
	 * "$0" cannot tell a free tier from an unpriced one, and the judge role
	 * prefers the free tier by name.
	 */
	test("marks a zero-rate decision row as free", async () => {
		const { fetch } = fetchOnce([
			decisionRow({
				id: "ngodeai/mercury-decide",
				display_name: "Mercury Decide",
				// The free row publishes a zero card on both currencies; leaving the
				// fixture's IDR card in place would describe a paid route.
				pricing: { input: 0, output: 0, cache_read: 0, cache_write: 0, currency: "IDR" },
				pricing_usd: {
					input: 0,
					output: 0,
					cache_read: 0,
					cache_write: 0,
					unit: "per_1m_tokens",
					currency: "USD",
				},
			}),
		]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.pricingStatus).toBe("free");
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	/**
	 * Jev bills input only: the gateway's card prices the prompt and leaves
	 * every other leg at zero. The output leg must stay zero rather than being
	 * backfilled from a bundled reference — a judgment returns a typed answer,
	 * not a completion, and charging for output would overstate its cost by the
	 * whole answer.
	 */
	test("keeps a paid decision row input-only", async () => {
		const { fetch } = fetchOnce([
			decisionRow({
				id: "ngodeai/jev-1.14",
				pricing: { input: 761, output: 0, cache_read: 0, cache_write: 0, currency: "IDR" },
				pricing_usd: {
					input: 0.042067,
					output: 0,
					cache_read: 0,
					cache_write: 0,
					unit: "per_1m_tokens",
					currency: "USD",
				},
			}),
		]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.pricingStatus).toBeUndefined();
		expect(model.cost?.input).toBeCloseTo(0.042067, 6);
		expect(model.cost?.output).toBe(0);
		expect(model.cost?.cacheRead).toBe(0);
		expect(model.cost?.cacheWrite).toBe(0);
	});

	/** A judgment's billed total is its prompt, and nothing else. */
	test("prices a judgment on input tokens alone", async () => {
		const { fetch } = fetchOnce([
			decisionRow({
				id: "ngodeai/jev-1.14",
				pricing_usd: {
					input: 0.042067,
					output: 0,
					cache_read: 0,
					cache_write: 0,
					unit: "per_1m_tokens",
					currency: "USD",
				},
			}),
		]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [spec] = (await options.fetchDynamicModels?.()) ?? [];
		const model = buildModel(spec);
		const cost = calculateCost(model, {
			input: 10_000,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10_500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});

		// 10,000 input tokens at $0.042067/M.
		expect(cost.input).toBeCloseTo(0.00042067, 8);
		expect(cost.output).toBe(0);
		expect(cost.total).toBeCloseTo(0.00042067, 8);
	});

	test("does not call an unpriced decision row free", async () => {
		// No `pricing_usd` at all: the gateway published no card, which is not the
		// same fact as charging nothing.
		const { fetch } = fetchOnce([decisionRow({ pricing_usd: undefined, pricing: undefined })]);
		const options = ngodeaiModelManagerOptions({ apiKey: "ngodeai_live_test", fetch });
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model.pricingStatus).not.toBe("free");
	});
});
