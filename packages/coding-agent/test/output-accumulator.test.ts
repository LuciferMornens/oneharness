import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.js";
import type { BashOperations } from "../src/core/tools/bash.js";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";

describe("OutputAccumulator temp spill", () => {
	const TMP_ENV_VARS = ["TMPDIR", "TEMP", "TMP"] as const;
	let realTmp: Record<string, string | undefined>;
	let scratch: string;

	// os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
	const setTmpDir = (dir: string) => {
		for (const name of TMP_ENV_VARS) process.env[name] = dir;
	};

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-accumulator-"));
		realTmp = Object.fromEntries(TMP_ENV_VARS.map((name) => [name, process.env[name]]));
	});

	afterEach(() => {
		for (const name of TMP_ENV_VARS) {
			if (realTmp[name] === undefined) delete process.env[name];
			else process.env[name] = realTmp[name];
		}
		rmSync(scratch, { recursive: true, force: true });
	});

	it("degrades a failed spill to the in-memory tail without failing the close", async () => {
		setTmpDir(join(scratch, "does-not-exist"));
		const accumulator = new OutputAccumulator({ maxBytes: 8, maxLines: 100 });
		accumulator.append(Buffer.from("0123456789abcdef\n"));
		accumulator.append(Buffer.from("tail\n"));
		accumulator.finish();

		// The open error lands while the close is waiting: degraded spill, not a tool failure.
		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
		const snapshot = accumulator.snapshot();
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.content).toContain("tail");
	});

	it("swallows spill-cleanup failures, keeping the tail and the process", async () => {
		// TMPDIR is a FILE: the open fails ENOTDIR and so does the cleanup rm.
		const blocker = join(scratch, "not-a-dir");
		writeFileSync(blocker, "x");
		setTmpDir(blocker);
		const accumulator = new OutputAccumulator({ maxBytes: 8, maxLines: 100 });
		accumulator.append(Buffer.from("0123456789abcdef\n"));
		accumulator.append(Buffer.from("tail\n"));
		accumulator.finish();

		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
		const snapshot = accumulator.snapshot();
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.content).toContain("tail");
	});

	it("advertises the bash spill path only once the file is complete", async () => {
		const chunk = Buffer.from(`${"x".repeat(4095)}\n`);
		const chunks = 2048; // 8 MiB, far past the spill threshold
		const ops: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 0; i < chunks; i++) {
					onData(chunk);
				}
				return { exitCode: 0 };
			},
		};

		const result = await executeBashWithOperations("noop", scratch, ops);

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		expect(statSync(result.fullOutputPath as string).size).toBe(chunk.length * chunks);
		rmSync(result.fullOutputPath as string, { force: true });
	});
});
