import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ORPHAN_PROCESS_JOURNAL_ENV, readActiveOrphanProcesses } from "../src/core/orphan-process-journal.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { isProcessAlive, signalProcessGroupOrProcess } from "../src/utils/child-process.js";
import {
	killTrackedDetachedChildren,
	reconcileTrackedDetachedChildAfterExit,
	trackDetachedChildPid,
} from "../src/utils/shell.js";

const childProcessTestState = vi.hoisted(() => ({ failTaskkill: false }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync(...args: Parameters<typeof actual.spawnSync>) {
			if (childProcessTestState.failTaskkill && args[0] === "taskkill.exe") {
				return { pid: 0, output: [], stdout: null, stderr: null, status: 1, signal: null };
			}
			return actual.spawnSync(...args);
		},
	};
});

describe("tracked detached children", () => {
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
		const descendantPid = await new Promise<number>((resolvePid) => {
			leader.stdout!.once("data", (chunk: Buffer) => {
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
			const descendantPid = await new Promise<number>((resolvePid) => {
				parent.stdout!.once("data", (chunk: Buffer) => {
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
