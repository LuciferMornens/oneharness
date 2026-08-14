import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ORPHAN_PROCESS_JOURNAL_ENV, readActiveOrphanProcesses } from "../src/core/orphan-process-journal.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import {
	isProcessAlive,
	isZombieProcess,
	signalProcessGroupOrProcess,
	waitForChildProcess,
} from "../src/utils/child-process.js";
import {
	killTrackedDetachedChildren,
	reconcileTrackedDetachedChildAfterExit,
	trackDetachedChildPid,
} from "../src/utils/shell.js";

const childProcessTestState = vi.hoisted(() => ({ failTaskkill: false }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const actualSpawnSync = Reflect.get(actual, "spawnSync") as (...args: unknown[]) => unknown;
	return {
		...actual,
		spawnSync(...args: unknown[]) {
			if (childProcessTestState.failTaskkill && args[0] === "taskkill.exe") {
				return { pid: 0, output: [], stdout: null, stderr: null, status: 1, signal: null };
			}
			return Reflect.apply(actualSpawnSync, undefined, args);
		},
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
		// Node reaps its own children on exit, so the pid is fully gone.
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		expect(isProcessAlive(child.pid!)).toBe(false);
	});

	it.skipIf(process.platform === "win32")("treats a zombie process as dead", async () => {
		// A parent that forks and never reaps leaves the child as a zombie.
		const parent = spawn(
			"perl",
			["-e", '$| = 1; my $pid = fork(); if ($pid) { print "$pid\\n"; sleep 30 } else { exit 0 }'],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		try {
			const zombiePid = await new Promise<number>((resolvePid, rejectPid) => {
				let output = "";
				const timer = setTimeout(() => rejectPid(new Error("Timed out waiting for the zombie pid")), 5000);
				parent.stdout.on("data", (chunk: Buffer) => {
					output += chunk.toString();
					const parsed = Number.parseInt(output.trim(), 10);
					if (Number.isInteger(parsed) && parsed > 0) {
						clearTimeout(timer);
						resolvePid(parsed);
					}
				});
			});
			const deadline = Date.now() + 5000;
			while (!isZombieProcess(zombiePid) && Date.now() < deadline) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
			}
			expect(isZombieProcess(zombiePid)).toBe(true);
			expect(isProcessAlive(zombiePid)).toBe(false);
		} finally {
			parent.kill("SIGKILL");
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
				'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(String(child.pid));',
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
