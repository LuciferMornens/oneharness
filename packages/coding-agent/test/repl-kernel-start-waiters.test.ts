import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as kernelBootstrap from "../src/core/kernel/bootstrap.js";
import { ReplKernelManager } from "../src/core/kernel/index.js";

const ensureKernelPythonMock = vi.hoisted(() => vi.fn());

vi.mock("../src/core/kernel/bootstrap.js", async (importOriginal) => {
	const original = await importOriginal<typeof kernelBootstrap>();
	return { ...original, ensureKernelPython: ensureKernelPythonMock };
});

let tempDir = "";

function writeFakeReplRuntime(): string {
	const python = join(tempDir, "python-repl");
	writeFileSync(
		python,
		`#!/usr/bin/env node
const readline = require("node:readline");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ event: "ready", protocol: 3, python: process.version });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "shutdown") {
		emit({ event: "done", id: request.id, status: "ok" });
		process.exit(0);
	}
});
`,
	);
	chmodSync(python, 0o755);
	return python;
}

/** ensureKernelPython stand-in: resolves when released, rejects when its signal aborts. */
function gatedEnsureKernelPython(python: string): {
	release: () => void;
	signals: AbortSignal[];
} {
	const signals: AbortSignal[] = [];
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	ensureKernelPythonMock.mockImplementation((options: { signal?: AbortSignal }) => {
		if (options.signal) signals.push(options.signal);
		return new Promise<string>((resolve, reject) => {
			const onAbort = () => reject(new Error("bootstrap aborted"));
			options.signal?.addEventListener("abort", onAbort, { once: true });
			void gate.then(() => {
				options.signal?.removeEventListener("abort", onAbort);
				if (options.signal?.aborted) return;
				resolve(python);
			});
		});
	});
	return { release, signals };
}

describe("ReplKernelManager concurrent start()", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-start-waiters-"));
		ensureKernelPythonMock.mockReset();
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("keeps the shared startup alive when only the first caller aborts", async () => {
		const python = writeFakeReplRuntime();
		const { release, signals } = gatedEnsureKernelPython(python);
		const manager = new ReplKernelManager({ cwd: tempDir });
		const first = new AbortController();
		const second = new AbortController();

		try {
			const firstStart = manager.start({ signal: first.signal });
			const secondStart = manager.start({ signal: second.signal });
			expect(ensureKernelPythonMock).toHaveBeenCalledTimes(1);

			first.abort();
			await expect(firstStart).rejects.toThrow("Kernel startup aborted");
			expect(signals[0]?.aborted).toBe(false);

			release();
			await expect(secondStart).resolves.toBeUndefined();
			expect(manager.isRunning).toBe(true);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	});

	it("aborts the shared startup once every caller has aborted", async () => {
		const python = writeFakeReplRuntime();
		const { release, signals } = gatedEnsureKernelPython(python);
		const manager = new ReplKernelManager({ cwd: tempDir });
		const first = new AbortController();
		const second = new AbortController();

		try {
			const firstStart = manager.start({ signal: first.signal });
			const secondStart = manager.start({ signal: second.signal });

			first.abort();
			await expect(firstStart).rejects.toThrow("Kernel startup aborted");
			expect(signals[0]?.aborted).toBe(false);

			second.abort();
			await expect(secondStart).rejects.toThrow("Kernel startup aborted");
			expect(signals[0]?.aborted).toBe(true);

			release();
			// The failed start cleared its memo, so a later start() spawns fresh.
			await manager.start();
			expect(ensureKernelPythonMock).toHaveBeenCalledTimes(2);
			expect(manager.isRunning).toBe(true);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	});

	it("a signal-less caller keeps the startup alive after signalled callers abort", async () => {
		const python = writeFakeReplRuntime();
		const { release, signals } = gatedEnsureKernelPython(python);
		const manager = new ReplKernelManager({ cwd: tempDir });
		const first = new AbortController();

		try {
			const firstStart = manager.start({ signal: first.signal });
			const secondStart = manager.start();

			first.abort();
			await expect(firstStart).rejects.toThrow("Kernel startup aborted");
			expect(signals[0]?.aborted).toBe(false);

			release();
			await expect(secondStart).resolves.toBeUndefined();
			expect(manager.isRunning).toBe(true);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	});
});
