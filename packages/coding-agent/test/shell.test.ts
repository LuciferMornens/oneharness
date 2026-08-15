import type { SpawnSyncReturns } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getShellConfig, isPowerShellShell } from "../src/utils/shell.js";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn<(path: string) => boolean>(),
	spawnSync: vi.fn<(command: string, args?: readonly string[]) => SpawnSyncReturns<string>>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	mocks.existsSync.mockImplementation((path) => actual.existsSync(path));
	return {
		...actual,
		existsSync: (path: Parameters<typeof actual.existsSync>[0]) => mocks.existsSync(String(path)),
	};
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return {
		...actual,
		spawnSync: mocks.spawnSync,
	};
});

const originalEnv = {
	PATH: process.env.PATH,
	Path: process.env.Path,
	ProgramFiles: process.env.ProgramFiles,
	"ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
	SystemRoot: process.env.SystemRoot,
};

afterEach(() => {
	vi.spyOn(process, "platform", "get").mockRestore();
	mocks.spawnSync.mockReset();
	process.env.PATH = originalEnv.PATH;
	process.env.Path = originalEnv.Path;
	process.env.ProgramFiles = originalEnv.ProgramFiles;
	process.env["ProgramFiles(x86)"] = originalEnv["ProgramFiles(x86)"];
	process.env.SystemRoot = originalEnv.SystemRoot;
});

function spawnResult(stdout: string, status = 0): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, stdout, ""],
		stdout,
		stderr: "",
		status,
		signal: null,
	};
}

function mockWindowsShellLookup(options: {
	pathSuffix: string;
	existing: readonly string[];
	where: Record<string, string[]>;
}): void {
	vi.spyOn(process, "platform", "get").mockReturnValue("win32");
	process.env.ProgramFiles = "C:\\Missing Program Files";
	process.env["ProgramFiles(x86)"] = "C:\\Missing Program Files (x86)";
	process.env.SystemRoot = "C:\\Windows";
	process.env.PATH = `C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32;${options.pathSuffix}`;
	const existing = new Set(options.existing);
	mocks.existsSync.mockImplementation((path) => existing.has(path));
	mocks.spawnSync.mockImplementation((command, args) => {
		const executable = args?.[0] ?? "";
		if (command === "where.exe") {
			const matches = options.where[executable] ?? [];
			return spawnResult(matches.join("\r\n"), matches.length > 0 ? 0 : 1);
		}
		return spawnResult("", 1);
	});
}

describe("Windows automatic shell resolution", () => {
	it("skips the WSL System32 bash launcher and selects PowerShell", () => {
		const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		mockWindowsShellLookup({
			pathSuffix: "wsl-only",
			existing: [pwsh],
			where: {
				"bash.exe": ["C:\\Windows\\System32\\bash.exe"],
				"pwsh.exe": [pwsh],
			},
		});

		const config = getShellConfig();
		expect(isPowerShellShell(config.shell)).toBe(true);
		expect(config.shell).toBe(pwsh);
		expect(config.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
	});

	it("skips SysWOW64 bash and still prefers a real bash later on PATH", () => {
		const msysBash = "C:\\tools\\msys64\\usr\\bin\\bash.exe";
		mockWindowsShellLookup({
			pathSuffix: "msys",
			existing: [msysBash],
			where: {
				"bash.exe": ["C:\\Windows\\SysWOW64\\bash.exe", msysBash],
			},
		});

		const config = getShellConfig();
		expect(config).toEqual({ shell: msysBash, args: ["-c"] });
	});
});
