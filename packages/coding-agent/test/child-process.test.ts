import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ORPHAN_PROCESS_JOURNAL_ENV, readActiveOrphanProcesses } from "../src/core/orphan-process-journal.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import {
	execFileHidden,
	execFileSyncHidden,
	execSyncHidden,
	isProcessAlive,
	isZombieProcess,
	processGroupExists,
	processGroupHasLiveMember,
	signalProcessGroupIfHeld,
	signalProcessGroupOrProcess,
	spawnHidden,
	spawnSyncHidden,
	waitForChildProcess,
} from "../src/utils/child-process.js";
import {
	killTrackedDetachedChildren,
	reconcileTrackedDetachedChildAfterExit,
	trackDetachedChildPid,
} from "../src/utils/shell.js";
import { spawnZombieProcess } from "./fixtures/zombie-process.js";

const childProcessTestState = vi.hoisted(() => ({ failTaskkill: false }));
const recordedWindowsHide = vi.hoisted(() => [] as Array<boolean | undefined>);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const wrap =
		<A extends unknown[], R>(fn: (...args: A) => R, optionsIndex: number) =>
		(...args: A): R => {
			recordedWindowsHide.push((args[optionsIndex] as { windowsHide?: boolean } | undefined)?.windowsHide);
			return fn(...args);
		};
	return {
		...actual,
		spawn: wrap(actual.spawn, 2),
		spawnSync(...args: Parameters<typeof actual.spawnSync>) {
			if (childProcessTestState.failTaskkill && args[0] === "taskkill.exe") {
				return { pid: 0, output: [], stdout: null, stderr: null, status: 1, signal: null };
			}
			recordedWindowsHide.push((args[2] as { windowsHide?: boolean } | undefined)?.windowsHide);
			return actual.spawnSync(...args);
		},
		execSync: wrap(actual.execSync, 1),
		execFileSync: wrap(actual.execFileSync, 2),
		execFile: wrap(actual.execFile, 2),
	};
});

describe("waitForChildProcess", () => {
	it("reports signaled already-exited children as failures", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: null,
			stderr: null,
			exitCode: null,
			signalCode: "SIGTERM" as NodeJS.Signals,
		});

		await expect(waitForChildProcess(child as unknown as ChildProcess)).resolves.toBe(143);
	});
});

describe("process liveness", () => {
	it("treats the current process as alive and not a zombie", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isZombieProcess(process.pid)).toBe(false);
	});

	it("treats an exited process as dead", async () => {
		const child = spawn(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" });
		await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		expect(isProcessAlive(child.pid!)).toBe(false);
	});

	it.skipIf(process.platform === "win32")("treats a zombie process as dead", async () => {
		const { zombiePid, dispose } = await spawnZombieProcess();
		try {
			expect(isZombieProcess(zombiePid)).toBe(true);
			expect(isProcessAlive(zombiePid)).toBe(false);
		} finally {
			dispose();
		}
	});

	it.skipIf(process.platform === "win32")("does not let an unreaped zombie block group-stop completion", async () => {
		// setpgrp makes the zombie its group's only member: the group exists, but
		// a stop waiting on it must complete because nothing is left running.
		const { zombiePid, dispose } = await spawnZombieProcess("setpgrp(0, 0);");
		try {
			expect(isZombieProcess(zombiePid)).toBe(true);
			expect(processGroupExists(zombiePid)).toBe(true);
			expect(processGroupHasLiveMember(zombiePid)).toBe(false);
		} finally {
			dispose();
		}
	});

	it.skipIf(process.platform === "win32")("keeps a process group alive after its leader exits", async () => {
		const childless = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
		const childlessExited = new Promise<void>((resolveExit) => childless.once("exit", () => resolveExit()));
		const leader = spawn("sh", ["-c", "sleep 30 & echo started"], {
			detached: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const leaderExited = new Promise<void>((resolveExit) => leader.once("exit", () => resolveExit()));
		const pgid = leader.pid!;
		try {
			await new Promise<void>((resolveStart, rejectStart) => {
				const timer = setTimeout(() => rejectStart(new Error("Timed out waiting for the group member")), 5000);
				leader.stdout?.once("data", () => {
					clearTimeout(timer);
					resolveStart();
				});
			});
			await leaderExited;
			expect(isProcessAlive(pgid)).toBe(false);
			expect(processGroupExists(pgid)).toBe(true);
			expect(processGroupHasLiveMember(pgid)).toBe(true);
			// A held group signals; a fully-gone group refuses (pgid-reuse gate).
			expect(signalProcessGroupIfHeld(pgid, "SIGKILL")).toBe(true);
			await childlessExited;
			expect(processGroupExists(childless.pid!)).toBe(false);
			expect(signalProcessGroupIfHeld(childless.pid!, "SIGKILL")).toBe(false);
		} finally {
			signalProcessGroupOrProcess(pgid, "SIGKILL");
		}
	});

	it.skipIf(process.platform === "win32")("terminates a detached group after its original leader exits", async () => {
		const journalDir = mkdtempSync(join(tmpdir(), "prime-detached-session-test-"));
		const journalPath = join(journalDir, "orphans.jsonl");
		const previousJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const leader = spawn(
			process.execPath,
			[
				"--eval",
				'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref(); process.stdout.write(String(child.pid));',
			],
			{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
		);
		if (!leader.pid || !leader.stdout) {
			throw new Error("Could not start the detached process-group fixture");
		}
		const expectedStartId = getProcessStartId(leader.pid);
		if (!expectedStartId) {
			throw new Error("Could not capture the detached leader identity");
		}
		expect(trackDetachedChildPid(leader.pid)).toBe(expectedStartId);
		const descendantPid = await new Promise<number>((resolvePid, rejectPid) => {
			const timeout = setTimeout(() => rejectPid(new Error("Timed out reading descendant pid")), 5000);
			leader.stdout!.once("data", (chunk: Buffer) => {
				clearTimeout(timeout);
				resolvePid(Number.parseInt(chunk.toString("utf8"), 10));
			});
		});
		await new Promise<void>((resolveExit) => leader.once("exit", () => resolveExit()));
		try {
			expect(isProcessAlive(descendantPid)).toBe(true);
			expect(reconcileTrackedDetachedChildAfterExit(leader.pid)).toBe("retained");
			expect(readActiveOrphanProcesses(journalPath, process.pid)).toContainEqual({
				pid: descendantPid,
				processStartId: getProcessStartId(descendantPid),
			});
			await expect(killTrackedDetachedChildren()).resolves.toBe(true);
			expect(isProcessAlive(descendantPid)).toBe(false);
			expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
		} finally {
			try {
				process.kill(descendantPid, "SIGKILL");
			} catch {
				// The exact group cleanup already reaped the fixture.
			}
			if (previousJournalPath === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = previousJournalPath;
			rmSync(journalDir, { recursive: true, force: true });
		}
	});
});

it("hidden child-process wrappers force windowsHide on every wrapped spawn/exec form", async () => {
	recordedWindowsHide.length = 0;
	const child = spawnHidden(process.execPath, ["--version"], { stdio: "ignore" });
	await waitForChildProcess(child);
	spawnSyncHidden(process.execPath, ["--version"], { stdio: "ignore" });
	execSyncHidden(`"${process.execPath}" --version`, { stdio: "ignore" });
	execFileSyncHidden(process.execPath, ["--version"], { stdio: "ignore" });
	await new Promise<void>((resolveDone) => {
		execFileHidden(process.execPath, ["--version"], {}, () => resolveDone());
	});
	expect(recordedWindowsHide).toEqual([true, true, true, true, true]);
});

describe("Windows process-tree signaling", () => {
	it.skipIf(process.platform !== "win32")(
		"retains a live tree when taskkill cannot prove complete termination",
		async () => {
			const parent = spawn(
				process.execPath,
				[
					"--eval",
					'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(String(child.pid) + "\\n"); setInterval(() => {}, 1000);',
				],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			if (!parent.pid || !parent.stdout) {
				throw new Error("Could not start the Windows taskkill fixture");
			}
			const descendantPid = await new Promise<number>((resolvePid, rejectPid) => {
				const timeout = setTimeout(() => rejectPid(new Error("Timed out reading child pid")), 5000);
				parent.stdout!.once("data", (chunk: Buffer) => {
					clearTimeout(timeout);
					resolvePid(Number.parseInt(chunk.toString("utf8").trim(), 10));
				});
			});
			try {
				childProcessTestState.failTaskkill = true;
				expect(signalProcessGroupOrProcess(parent.pid, "SIGKILL")).toBe(false);
				expect(isProcessAlive(parent.pid)).toBe(true);
				expect(isProcessAlive(descendantPid)).toBe(true);
			} finally {
				childProcessTestState.failTaskkill = false;
				signalProcessGroupOrProcess(parent.pid, "SIGKILL");
				await new Promise<void>((resolveExit) => parent.once("exit", () => resolveExit()));
			}
		},
	);
});
