import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { type ChildProcess, spawnSync } from "child_process";
import { getBinDir } from "../config.js";
import { recordOrphanProcessState } from "../core/orphan-process-journal.js";
import { getProcessStartId } from "../core/session-lease.js";
import {
	inspectUnixProcessSessionByIdentity,
	signalProcessGroupOrProcess,
	terminateUnixProcessGroupByIdentity,
	terminateWindowsProcessTreeByIdentity,
} from "./child-process.js";

export interface ShellConfig {
	shell: string;
	args: string[];
}

let automaticShellConfigCache: { key: string; config: ShellConfig } | undefined;

function automaticShellConfigKey(): string {
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
	return [
		process.platform,
		pathKey ? process.env[pathKey] : undefined,
		process.env.ProgramFiles,
		process.env["ProgramFiles(x86)"],
		process.env.SystemRoot,
	].join("\0");
}

function cacheAutomaticShellConfig(key: string, config: ShellConfig): ShellConfig {
	automaticShellConfigCache = { key, config };
	return config;
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function isWindowsWslBashLauncher(shellPath: string): boolean {
	const normalized = shellPath.replace(/\//g, "\\").toLowerCase();
	return normalized.endsWith("\\system32\\bash.exe") || normalized.endsWith("\\syswow64\\bash.exe");
}

function findExecutableOnWindowsPath(
	executable: string,
	isUsable: (path: string) => boolean = () => true,
): string | null {
	try {
		const result = spawnSync("where.exe", [executable], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		});
		if (result.status === 0 && result.stdout) {
			for (const match of result.stdout.trim().split(/\r?\n/)) {
				if (match && existsSync(match) && isUsable(match)) {
					return match;
				}
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		return findExecutableOnWindowsPath("bash.exe", (path) => !isWindowsWslBashLauncher(path));
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", ["bash"], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		});
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

export function isPowerShellShell(shellPath: string): boolean {
	const executable = shellPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
	return (
		executable === "pwsh" ||
		executable === "pwsh.exe" ||
		executable === "powershell" ||
		executable === "powershell.exe"
	);
}

function shellArgs(shellPath: string): string[] {
	if (isPowerShellShell(shellPath)) {
		return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];
	}
	return ["-c"];
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, bash on PATH, then PowerShell
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: shellArgs(customShellPath) };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	const cacheKey = automaticShellConfigKey();
	if (automaticShellConfigCache?.key === cacheKey) {
		return automaticShellConfigCache.config;
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return cacheAutomaticShellConfig(cacheKey, { shell: path, args: ["-c"] });
			}
		}

		// 3. Fallback: search bash.exe on PATH (Git Bash, Cygwin, MSYS2). Skip the WSL launcher.
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			return cacheAutomaticShellConfig(cacheKey, { shell: bashOnPath, args: ["-c"] });
		}

		const windowsPowerShell = process.env.SystemRoot
			? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
			: undefined;
		const powershell =
			findExecutableOnWindowsPath("pwsh.exe") ??
			findExecutableOnWindowsPath("powershell.exe") ??
			(windowsPowerShell && existsSync(windowsPowerShell) ? windowsPowerShell : undefined);
		if (powershell) {
			return cacheAutomaticShellConfig(cacheKey, { shell: powershell, args: shellArgs(powershell) });
		}

		throw new Error(
			`No supported shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add bash, pwsh, or powershell to PATH\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return cacheAutomaticShellConfig(cacheKey, { shell: "/bin/bash", args: ["-c"] });
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return cacheAutomaticShellConfig(cacheKey, { shell: bashOnPath, args: ["-c"] });
	}

	return cacheAutomaticShellConfig(cacheKey, { shell: "sh", args: ["-c"] });
}

// Hardcoded literals: ProgramFiles env vars are ambient attacker-influenceable
// input, the same trust-laundering class as PATH.
const WINDOWS_GIT_BASH_PATHS = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];

/**
 * Absolute default shell for the kernel's bash(): explicit shellPath wins; POSIX
 * uses /bin/bash else /bin/sh (absolute, never PATH — the kernel inherits a
 * user-influenced PATH); win32 uses only the canonical Git Bash install paths,
 * never PATH (a repo-controlled PATH/where.exe must not pick the kernel shell).
 * undefined = no shell found: kernel startup must not fail, bash() raises its
 * teaching error.
 */
export function resolveKernelBashShell(customShellPath?: string): string | undefined {
	const explicit = customShellPath?.trim();
	if (explicit) {
		return explicit;
	}
	if (process.platform !== "win32") {
		return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
	}
	for (const path of WINDOWS_GIT_BASH_PATHS) {
		if (existsSync(path)) {
			return path;
		}
	}
	return undefined;
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
interface TrackedDetachedChild {
	processStartId: string | undefined;
	unixDetachedSession: boolean;
	unixDescendants: Map<number, string>;
}

const trackedDetachedChildren = new Map<number, TrackedDetachedChild>();

function setTrackedDetachedChild(pid: number, processStartId: string | undefined, unixDetachedSession: boolean): void {
	trackedDetachedChildren.set(pid, { processStartId, unixDetachedSession, unixDescendants: new Map() });
	recordOrphanProcessState(pid, true, processStartId ?? null);
}

export function trackDetachedChildPid(pid: number): string | undefined {
	const processStartId = getProcessStartId(pid);
	setTrackedDetachedChild(pid, processStartId, process.platform !== "win32");
	return processStartId;
}

export function trackChildProcess(
	child: ChildProcess,
	options: { unixDetachedSession?: boolean } = {},
): string | undefined {
	if (!child.pid) {
		return undefined;
	}
	const processStartId = getProcessStartId(child.pid);
	if (child.exitCode !== null || child.signalCode !== null || !child.kill(0)) {
		return undefined;
	}
	setTrackedDetachedChild(child.pid, processStartId, options.unixDetachedSession === true);
	return processStartId;
}

export function untrackDetachedChildPid(pid: number): void {
	const tracked = trackedDetachedChildren.get(pid);
	trackedDetachedChildren.delete(pid);
	recordOrphanProcessState(pid, false);
	for (const descendantPid of tracked?.unixDescendants.keys() ?? []) {
		recordOrphanProcessState(descendantPid, false);
	}
}

export function reconcileTrackedDetachedChildAfterExit(pid: number): "cleared" | "retained" {
	const tracked = trackedDetachedChildren.get(pid);
	if (!tracked) {
		return "cleared";
	}
	if (process.platform === "win32") {
		untrackDetachedChildPid(pid);
		return "cleared";
	}
	if (!tracked.unixDetachedSession || !tracked.processStartId) {
		return "retained";
	}
	const inspection = inspectUnixProcessSessionByIdentity(pid, tracked.processStartId, getProcessStartId);
	if (inspection.status === "not-found" || inspection.status === "identity-mismatch") {
		untrackDetachedChildPid(pid);
		return "cleared";
	}
	if (inspection.status !== "active") {
		return "retained";
	}
	const descendants = new Map(
		inspection.members
			.filter((member) => member.pid !== pid)
			.map((member) => [member.pid, member.processStartId] as const),
	);
	for (const descendantPid of tracked.unixDescendants.keys()) {
		if (!descendants.has(descendantPid)) {
			recordOrphanProcessState(descendantPid, false);
		}
	}
	for (const [descendantPid, processStartId] of descendants) {
		recordOrphanProcessState(descendantPid, true, processStartId);
	}
	tracked.unixDescendants = descendants;
	return "retained";
}

export async function killTrackedDetachedChildren(): Promise<boolean> {
	let complete = true;
	for (const [pid, tracked] of [...trackedDetachedChildren]) {
		let terminated: boolean;
		if (process.platform === "win32") {
			if (tracked.processStartId === undefined) {
				terminated = false;
			} else {
				const result = await terminateWindowsProcessTreeByIdentity(pid, tracked.processStartId);
				terminated = result === "terminated" || result === "not-found";
			}
		} else {
			if (!tracked.unixDetachedSession) {
				terminated = killProcessTree(pid);
			} else if (tracked.processStartId === undefined) {
				terminated = false;
			} else {
				const result = await terminateUnixProcessGroupByIdentity(pid, tracked.processStartId, getProcessStartId);
				terminated = result === "terminated" || result === "not-found";
			}
		}
		if (terminated) {
			untrackDetachedChildPid(pid);
		} else {
			complete = false;
		}
	}
	return complete;
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): boolean {
	return signalProcessGroupOrProcess(pid, "SIGKILL");
}

export async function killProcessTreeByIdentity(pid: number, processStartId: string | undefined): Promise<boolean> {
	if (!processStartId) {
		return false;
	}
	const result =
		process.platform === "win32"
			? await terminateWindowsProcessTreeByIdentity(pid, processStartId)
			: await terminateUnixProcessGroupByIdentity(pid, processStartId, getProcessStartId);
	return result === "terminated" || result === "not-found";
}
