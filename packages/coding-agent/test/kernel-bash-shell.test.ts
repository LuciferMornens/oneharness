import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	// Module-load reads (config.ts) must see the real fs; tests override per case.
	mocks.existsSync.mockImplementation(actual.existsSync);
	return { ...actual, existsSync: mocks.existsSync };
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return { ...actual, spawnSync: mocks.spawnSync };
});

import { orderWindowsBashCandidates, resolveKernelShell } from "../src/utils/shell.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function stubWin32(): void {
	Object.defineProperty(process, "platform", { value: "win32" });
}

afterEach(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
	mocks.existsSync.mockClear();
	mocks.spawnSync.mockClear();
});

describe("resolveKernelShell on win32", () => {
	const canonical = "C:\\Program Files\\Git\\bin\\bash.exe";
	const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

	it("reports an issue without consulting PATH when no Git Bash is installed", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		const resolution = resolveKernelShell({});
		expect(resolution.shell).toBeUndefined();
		expect(resolution.source).toBe("none");
		expect(resolution.issue).toContain("kernelShellPath");
		// A repo-controlled PATH/where.exe must never pick the kernel shell.
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("returns the canonical Git Bash install path when present", () => {
		stubWin32();
		mocks.existsSync.mockImplementation((path: string) => path === canonical);

		expect(resolveKernelShell({})).toEqual({ shell: canonical, source: "git-bash" });
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("prefers an existing absolute kernelShellPath over Git Bash", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(true);

		expect(resolveKernelShell({ kernelShellPath: "D:\\tools\\bash.exe", shellPath: pwsh })).toEqual({
			shell: "D:\\tools\\bash.exe",
			source: "kernelShellPath",
		});
	});

	it("uses a POSIX shellPath for the kernel", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(true);

		expect(resolveKernelShell({ shellPath: "D:\\msys64\\usr\\bin\\bash.exe" })).toEqual({
			shell: "D:\\msys64\\usr\\bin\\bash.exe",
			source: "shellPath",
		});
	});

	it("skips a PowerShell shellPath and explains it when no Git Bash exists", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		const resolution = resolveKernelShell({ shellPath: pwsh });
		expect(resolution.shell).toBeUndefined();
		expect(resolution.issue).toContain(pwsh);
		expect(resolution.issue).toContain("bash tool only");
	});

	it("falls through a PowerShell shellPath to Git Bash", () => {
		stubWin32();
		mocks.existsSync.mockImplementation((path: string) => path === canonical);

		expect(resolveKernelShell({ shellPath: pwsh })).toEqual({ shell: canonical, source: "git-bash" });
	});

	it.each([
		["a relative path", "tools\\bash.exe", true, "absolute"],
		["a missing file", "D:\\missing\\bash.exe", false, "does not exist"],
		["PowerShell", pwsh, true, "POSIX shell"],
		["cmd.exe", "C:\\Windows\\System32\\cmd.exe", true, "POSIX shell"],
	])("fails closed when kernelShellPath is %s", (_label, kernelShellPath, exists, expectedIssue) => {
		stubWin32();
		mocks.existsSync.mockReturnValue(exists);

		const resolution = resolveKernelShell({ kernelShellPath });
		expect(resolution.shell).toBeUndefined();
		expect(resolution.source).toBe("none");
		expect(resolution.issue).toContain("kernelShellPath");
		expect(resolution.issue).toContain(expectedIssue);
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});
});

it("orderWindowsBashCandidates prefers any other bash over WSL's System32 trampoline, keeping it only as a last resort", () => {
	const wsl = "C:\\Windows\\System32\\bash.exe";
	const scoopGitBash = "C:\\Users\\u\\scoop\\shims\\bash.exe";
	expect(orderWindowsBashCandidates([wsl, scoopGitBash], "C:\\Windows")).toEqual([scoopGitBash, wsl]);
	expect(orderWindowsBashCandidates([wsl], "C:\\Windows")).toEqual([wsl]);
	expect(orderWindowsBashCandidates([wsl, scoopGitBash], undefined)).toEqual([wsl, scoopGitBash]);
});

it.each(["C:\\Windows", "C:\\Windows\\", "C:/Windows/", "c:\\WINDOWS\\\\"])(
	"normalizes candidate comparisons under %s without changing paths or stable order",
	(systemRoot) => {
		const wsl = "C:/Windows/System32/bash.exe";
		const neighboringDirectory = "C:\\WindowsExtra\\bash.exe";
		const scoop = "C:\\Users\\u\\scoop\\shims\\bash.exe";
		const winget = "D:/Git/bin/bash.exe";
		expect(orderWindowsBashCandidates([wsl, neighboringDirectory, scoop, winget], systemRoot)).toEqual([
			neighboringDirectory,
			scoop,
			winget,
			wsl,
		]);
		const backslashWsl = wsl.replaceAll("/", "\\");
		expect(orderWindowsBashCandidates([backslashWsl, scoop], systemRoot)).toEqual([scoop, backslashWsl]);
	},
);
