/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawnHidden, waitForChildProcess } from "../utils/child-process.js";
import {
	killProcessTreeByIdentity,
	reconcileTrackedDetachedChildAfterExit,
	trackChildProcess,
} from "../utils/shell.js";

const WINDOWS_COMMAND_TERMINATION_SETTLE_MS = 31_000;

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/**
	 * Extra env vars merged over the parent process env for this command.
	 * A key with an undefined value is unset in the child.
	 */
	env?: Record<string, string | undefined>;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

function mergeExecEnv(env?: Record<string, string | undefined>): NodeJS.ProcessEnv | undefined {
	if (!env) {
		return undefined;
	}
	const merged: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete merged[key];
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawnHidden(command, args, {
			cwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			// Merge per-call env over the parent env so callers can scope vars
			// (e.g. herdr pane identity) without mutating the shared process.env.
			env: mergeExecEnv(options?.env),
		});
		const processStartId = trackChildProcess(proc, {
			unixDetachedSession: process.platform !== "win32",
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let killRequested = false;
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let terminationSettleTimeoutId: NodeJS.Timeout | undefined;
		let terminationPromise: Promise<boolean> | undefined;

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			if (terminationSettleTimeoutId) clearTimeout(terminationSettleTimeoutId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
		};

		const settleFailedTermination = () => {
			if (settled) return;
			settled = true;
			cleanup();
			proc.stdout?.destroy();
			proc.stderr?.destroy();
			proc.unref();
			resolve({ stdout, stderr, code: 1, killed: false });
		};

		const killProcess = () => {
			if (!killRequested) {
				killRequested = true;
				if (proc.pid !== undefined) {
					if (process.platform === "win32") {
						terminationSettleTimeoutId = setTimeout(
							settleFailedTermination,
							WINDOWS_COMMAND_TERMINATION_SETTLE_MS,
						);
					}
					terminationPromise = killProcessTreeByIdentity(proc.pid, processStartId);
					void terminationPromise.then(
						(complete) => {
							killed = complete;
							if (!complete) settleFailedTermination();
						},
						() => settleFailedTermination(),
					);
					return;
				}
				killed = proc.kill("SIGKILL");
			}
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then(async (code) => {
				if (settled) return;
				if (terminationPromise) {
					killed = await terminationPromise;
					if (settled) return;
					if (!killed) {
						settleFailedTermination();
						return;
					}
				}
				settled = true;
				if (proc.pid) reconcileTrackedDetachedChildAfterExit(proc.pid);
				cleanup();
				resolve({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch((_err) => {
				if (settled) return;
				settled = true;
				if (proc.pid && (proc.exitCode !== null || proc.signalCode !== null)) {
					reconcileTrackedDetachedChildAfterExit(proc.pid);
				}
				cleanup();
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
