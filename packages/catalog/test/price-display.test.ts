/**
 * Price display: free and unknown must never look alike.
 *
 * The gateway serves a free decision model beside a paid one, and a row with
 * no published card is neither. A picker that prints `$0.0000` for all three
 * tells the operator nothing about what a session will cost.
 */
import { describe, expect, test } from "bun:test";
import { buildModel } from "@ngodeai/catalog/build";
import { getModelPricingStatus } from "@ngodeai/catalog/models";
import type { ModelSpec } from "@ngodeai/catalog/types";

function spec(overrides: Partial<ModelSpec> = {}): ModelSpec {
	return {
		id: "ngodeai/test",
		provider: "ngodeai",
		api: "typesafe",
		baseUrl: "https://llm.ngodeai.net",
		name: "Test",
		input: ["text"],
		reasoning: false,
		supportsTools: false,
		contextWindow: 65536,
		maxTokens: 2048,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as ModelSpec;
}

describe("getModelPricingStatus", () => {
	test("reads a zero card with no declared state as unknown, not free", () => {
		expect(getModelPricingStatus(buildModel(spec()))).toBe("unknown");
	});

	test("reads a declared free row as free", () => {
		expect(getModelPricingStatus(buildModel(spec({ pricingStatus: "free" })))).toBe("free");
	});

	test("reads a priced row as fixed", () => {
		const model = buildModel(spec({ cost: { input: 0.016583, output: 0.033167, cacheRead: 0, cacheWrite: 0 } }));
		expect(getModelPricingStatus(model)).toBe("fixed");
	});

	test("a priced row's status wins over a stale free declaration", () => {
		const model = buildModel(
			spec({
				pricingStatus: "free",
				cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		expect(getModelPricingStatus(model)).toBe("fixed");
	});
});
