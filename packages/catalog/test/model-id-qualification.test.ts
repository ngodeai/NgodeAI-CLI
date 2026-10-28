/**
 * The id helpers that keep a model's identity in one spelling.
 *
 * A discovered row may carry its provider inside the id (`ngodeai/jev-1.14`)
 * while a bundled row carries a bare id with the provider stored separately
 * (`jev-1.14` + `provider: "ngodeai"`). Both forms reach the UI, and code that
 * pasted `provider + "/" + id` produced `ngodeai/ngodeai/jev-1.14` — visible in
 * the transcript, the sidebar, and every judgment log line.
 */
import { describe, expect, test } from "bun:test";
import { stripModelProviderPrefix, qualifyModelId } from "@ngodeai/catalog/utils";

describe("qualifyModelId", () => {
	test("prefixes a bare id", () => {
		expect(qualifyModelId("ngodeai", "jev-1.14")).toBe("ngodeai/jev-1.14");
	});

	test("leaves an already-qualified id alone", () => {
		expect(qualifyModelId("ngodeai", "ngodeai/jev-1.14")).toBe("ngodeai/jev-1.14");
	});

	test("does not treat a different provider's prefix as its own", () => {
		expect(qualifyModelId("ngodeai", "openrouter/anthropic/claude")).toBe("ngodeai/openrouter/anthropic/claude");
	});
});

describe("stripModelProviderPrefix", () => {
	test("strips the provider's own prefix", () => {
		expect(stripModelProviderPrefix("ngodeai", "ngodeai/jev-1.14")).toBe("jev-1.14");
	});

	test("leaves a bare id alone", () => {
		expect(stripModelProviderPrefix("ngodeai", "jev-1.14")).toBe("jev-1.14");
	});

	test("does not strip a nested id belonging to an upstream provider", () => {
		// `openrouter` rows carry an upstream namespace; the first segment is not
		// the row's own provider, so it must survive.
		expect(stripModelProviderPrefix("openrouter", "openrouter/anthropic/claude-3.5")).toBe("anthropic/claude-3.5");
	});

	test("round-trips with qualifyModelId", () => {
		for (const id of ["jev-1.14", "ngodeai/jev-1.14", "anthropic/claude-3.5"]) {
			const qualified = qualifyModelId("ngodeai", id);
			expect(qualifyModelId("ngodeai", stripModelProviderPrefix("ngodeai", qualified))).toBe(qualified);
		}
	});
});
