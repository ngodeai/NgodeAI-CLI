/**
 * The `/models` price column.
 *
 * Every rate on the gateway is per million tokens, and the decision models
 * bill input only — so the column shows `in/out` and lets a zero output leg
 * speak for itself. The cases worth pinning are the ones a coarse formatter
 * gets wrong: a sub-cent rate rounded into uselessness, and a free tier that
 * must not read as an unknown price.
 */
import { describe, expect, test } from "bun:test";
import { buildModel } from "@ngodeai/catalog/build";
import type { ModelSpec } from "@ngodeai/catalog/types";
import { formatPrice } from "../src/cli/models-cli";

function model(overrides: Partial<ModelSpec> = {}) {
	return buildModel({
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
	} as ModelSpec);
}

describe("formatPrice", () => {
	test("prints a free tier as free", () => {
		expect(formatPrice(model({ pricingStatus: "free" }))).toBe("free");
	});

	test("prints an unpublished card as ?", () => {
		expect(formatPrice(model())).toBe("?");
	});

	test("keeps a sub-cent rate recognisable", () => {
		const price = formatPrice(model({ cost: { input: 0.016583, output: 0.033167, cacheRead: 0, cacheWrite: 0 } }));
		expect(price).toBe("$0.0166/$0.0332");
	});

	test("shows a decision model's zero output leg as 0", () => {
		// Jev bills input only; a `$0.0391/$0` cell says that plainly.
		expect(formatPrice(model({ cost: { input: 0.039137, output: 0, cacheRead: 0, cacheWrite: 0 } }))).toBe(
			"$0.0391/$0",
		);
	});

	test("drops trailing zeros on whole-dollar rates", () => {
		expect(formatPrice(model({ cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }))).toBe("$3/$15");
	});

	test("prints included and variable states by name", () => {
		expect(formatPrice(model({ pricingStatus: "included" }))).toBe("included");
		expect(formatPrice(model({ pricingStatus: "variable" }))).toBe("variable");
	});
});
