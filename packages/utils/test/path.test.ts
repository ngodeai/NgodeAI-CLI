import { describe, expect, it } from "bun:test";
import { isFullyQualifiedPath, stripWindowsExtendedLengthPathPrefix, windowsPathToWslMount } from "../src/path";

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("removes drive and UNC extended-length prefixes on Windows", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\Users\\Shi Xin\\ngodeai.exe", "win32")).toBe(
			"C:\\Users\\Shi Xin\\ngodeai.exe",
		);
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share\\ngodeai.exe", "win32")).toBe(
			"\\\\server\\share\\ngodeai.exe",
		);
	});

	it("leaves non-Windows paths unchanged", () => {
		const path = "\\\\?\\C:\\Users\\Shi Xin\\ngodeai.exe";
		expect(stripWindowsExtendedLengthPathPrefix(path, "linux")).toBe(path);
	});
});

describe("windowsPathToWslMount", () => {
	it("clamps parent traversal at the Windows drive root", () => {
		expect(windowsPathToWslMount("C:\\..\\Windows\\x")).toBe("/mnt/c/Windows/x");
	});

	it("rejects paths without an absolute Windows drive", () => {
		expect(windowsPathToWslMount("/home/me/file.txt")).toBeUndefined();
	});
});

describe("isFullyQualifiedPath", () => {
	it("identifies fully qualified Windows paths across platforms", () => {
		expect(isFullyQualifiedPath("C:\\ngodeai\\bin\\ngodeai.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("c:/ngodeai/bin/ngodeai.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("\\\\server\\share\\ngodeai.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("//server/share/ngodeai.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("C:ngodeai", "win32")).toBe(false);
		expect(isFullyQualifiedPath(".\\ngodeai", "win32")).toBe(false);
		expect(isFullyQualifiedPath("\\bin\\ngodeai", "win32")).toBe(false);
		expect(isFullyQualifiedPath("/bin/ngodeai", "win32")).toBe(false);
		expect(isFullyQualifiedPath("//", "win32")).toBe(false);
		expect(isFullyQualifiedPath("\\\\", "win32")).toBe(false);
	});

	it("identifies absolute POSIX paths", () => {
		expect(isFullyQualifiedPath("/usr/local/bin/ngodeai", "darwin")).toBe(true);
		expect(isFullyQualifiedPath("/usr/local/bin/ngodeai", "linux")).toBe(true);
		expect(isFullyQualifiedPath("./ngodeai", "darwin")).toBe(false);
		expect(isFullyQualifiedPath("ngodeai", "linux")).toBe(false);
	});
});
