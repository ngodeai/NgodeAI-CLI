/**
 * User-declared decision points.
 *
 * A point file is executable policy: its criteria define what a judgment
 * means. Two properties matter more than the happy path — a malformed file is
 * rejected rather than half-loaded, and a file can tighten a threshold but
 * never loosen one.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@ngodeai/utils";
import {
	effectiveAutoThreshold,
	loadDecisionPoints,
	loadDecisionPointsFrom,
	parseDecisionPoint,
} from "../src/judgment";

describe("parseDecisionPoint", () => {
	it("derives question types from the criteria shape", () => {
		const point = parseDecisionPoint(
			"release",
			{
				risk: "write",
				questions: {
					ready: { instructions: "Is it ready?" },
					coverage: { instructions: "How covered?", criteria: ["none", "partial", "full"] },
					kind: { instructions: "Which kind?", criteria: { fix: "a fix", feat: "a feature" } },
					blocking: { instructions: "Blocking?", criteria: { true: "yes", false: "no" } },
				},
			},
			"test",
		);

		expect(point.questions.ready.type).toBe("noul");
		expect(point.questions.coverage.type).toBe("score");
		expect(point.questions.kind.type).toBe("choice");
		expect(point.questions.blocking.type).toBe("noul");
	});

	it("rejects a file with no questions", () => {
		expect(() => parseDecisionPoint("empty", { questions: {} }, "test")).toThrow("at least one question");
	});

	it("rejects a file with no questions key", () => {
		expect(() => parseDecisionPoint("bad", { risk: "read" }, "test")).toThrow('"questions" must be an object');
	});

	it("rejects a score question with one level", () => {
		expect(() =>
			parseDecisionPoint("bad", { questions: { q: { instructions: "x", criteria: ["only"] } } }, "test"),
		).toThrow("at least two levels");
	});

	it("rejects an out-of-range threshold", () => {
		expect(() =>
			parseDecisionPoint("bad", { autoThreshold: 1.5, questions: { q: { instructions: "x" } } }, "test"),
		).toThrow("between 0 and 1");
	});

	it("defaults an unknown risk class to the safest reading, never upward", () => {
		const point = parseDecisionPoint("p", { risk: "everything", questions: { q: { instructions: "x" } } }, "test");
		expect(point.risk).toBe("read");
	});
});

describe("effectiveAutoThreshold", () => {
	it("lets a file tighten a gate", () => {
		const point = parseDecisionPoint("p", { autoThreshold: 0.99, questions: { q: { instructions: "x" } } }, "test");
		expect(effectiveAutoThreshold(point, 0.85)).toBe(0.99);
	});

	it("does not let a file loosen a gate", () => {
		const point = parseDecisionPoint("p", { autoThreshold: 0.1, questions: { q: { instructions: "x" } } }, "test");
		expect(effectiveAutoThreshold(point, 0.95)).toBe(0.95);
	});

	it("uses the class ceiling when the file states none", () => {
		const point = parseDecisionPoint("p", { questions: { q: { instructions: "x" } } }, "test");
		expect(effectiveAutoThreshold(point, 0.85)).toBe(0.85);
	});
});

describe("loadDecisionPoints", () => {
	it("reads every json file in the directory", () => {
		using tempDir = TempDir.createSync("@ngodeai-points-");
		const dir = path.join(tempDir.path(), ".ngodeai", "decisions");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "one.json"), JSON.stringify({ questions: { q: { instructions: "a" } } }));
		fs.writeFileSync(path.join(dir, "two.json"), JSON.stringify({ questions: { q: { instructions: "b" } } }));

		const loaded = loadDecisionPointsFrom(dir);
		expect(loaded.points.map(p => p.id).sort()).toEqual(["one", "two"]);
		expect(loaded.errors).toHaveLength(0);
	});

	it("reports a malformed file without hiding the good ones", () => {
		using tempDir = TempDir.createSync("@ngodeai-points-");
		const dir = path.join(tempDir.path(), ".ngodeai", "decisions");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "good.json"), JSON.stringify({ questions: { q: { instructions: "a" } } }));
		fs.writeFileSync(path.join(dir, "bad.json"), "{ not json");

		const loaded = loadDecisionPointsFrom(dir);
		expect(loaded.points.map(p => p.id)).toEqual(["good"]);
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]).toContain("bad.json");
	});

	it("treats a missing directory as no points", () => {
		using tempDir = TempDir.createSync("@ngodeai-points-");
		const loaded = loadDecisionPointsFrom(path.join(tempDir.path(), "nope"));
		expect(loaded.points).toHaveLength(0);
		expect(loaded.errors).toHaveLength(0);
	});

	it("lets a project point override a user point of the same id", () => {
		using tempDir = TempDir.createSync("@ngodeai-points-");
		const agentDir = path.join(tempDir.path(), "agent");
		const cwd = path.join(tempDir.path(), "project");
		fs.mkdirSync(path.join(agentDir, "decisions"), { recursive: true });
		fs.mkdirSync(path.join(cwd, ".ngodeai", "decisions"), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "decisions", "shared.json"),
			JSON.stringify({ label: "user version", questions: { q: { instructions: "a" } } }),
		);
		fs.writeFileSync(
			path.join(cwd, ".ngodeai", "decisions", "shared.json"),
			JSON.stringify({ label: "project version", questions: { q: { instructions: "b" } } }),
		);

		const loaded = loadDecisionPoints({ cwd, agentDir });
		expect(loaded.points).toHaveLength(1);
		expect(loaded.points[0].label).toBe("project version");
	});
});
