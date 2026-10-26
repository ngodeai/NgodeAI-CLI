/**
 * The judge role's default chain.
 *
 * Ordering is a policy decision with a price attached: a free decision model
 * must be tried before a paid one, so a session that can reach the gateway's
 * shared tier gets calibrated judgments without spending anything. The chain
 * is also the only place the preference is written down, so it is worth
 * pinning rather than leaving to a comment.
 */
import { describe, expect, test } from "bun:test";
import { roleDefaultModels } from "@ngodeai/catalog/compat/behavior";

describe("judge role defaults", () => {
	const chain = roleDefaultModels().judge ?? [];

	test("offers the free gateway decision model first", () => {
		expect(chain[0]).toBe("ngodeai/mercury-decide");
	});

	test("offers the paid gateway decision model, but never first", () => {
		const paid = chain.indexOf("ngodeai/jev-1.14");
		expect(paid).toBeGreaterThan(0);
	});

	test("keeps the direct TypeSafe route as a fallback", () => {
		// An account with a TypeSafe key and no gateway key still resolves.
		expect(chain).toContain("typesafe/jev-1.14.0");
		expect(chain.indexOf("typesafe/jev-1.14.0")).toBeGreaterThan(chain.indexOf("ngodeai/mercury-decide"));
	});

	test("ends with the session's own models, so a judge always resolves", () => {
		expect(chain).toContain("@tiny");
		expect(chain).toContain("@smol");
		expect(chain).toContain("@default");
		expect(chain[chain.length - 1]).toBe("@default");
	});

	test("lists every free option before every paid one", () => {
		// Free: the gateway's shared tier. Paid: everything with a rate card.
		const free = chain.indexOf("ngodeai/mercury-decide");
		const paid = [
			chain.indexOf("ngodeai/jev-1.14"),
			chain.indexOf("typesafe/jev-1.14.0"),
			chain.indexOf("openrouter/typesafe/jev-1.14"),
		].filter(index => index >= 0);
		for (const index of paid) expect(free).toBeLessThan(index);
	});
});
