import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	// The open error lands while the close is waiting: degraded spill, not a tool failure.
	it.each([
		["a missing temp dir (ENOENT)", (dir: string) => join(dir, "does-not-exist")],
		[
			"a temp dir that is a file (ENOTDIR, so cleanup fails too)",
			(dir: string) => {
				const blocker = join(dir, "not-a-dir");
				writeFileSync(blocker, "x");
				return blocker;
			},
		],
	])("degrades a failed spill to the in-memory tail with %s", async (_label, makeTmpdir) => {
		setTmpDir(makeTmpdir(scratch));
		const accumulator = new OutputAccumulator({ maxBytes: 8, maxLines: 100 });
		accumulator.append(Buffer.from("0123456789abcdef\n"));
		accumulator.append(Buffer.from("tail\n"));
		accumulator.finish();

		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
		const snapshot = accumulator.snapshot();
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.content).toContain("tail");
	});
});
