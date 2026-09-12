import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({
	args: [] as string[],
	child: undefined as (EventEmitter & { connected: boolean }) | undefined,
}));

vi.mock("node:child_process", () => ({
	spawn(_command: string, args: string[], _options: SpawnOptions): ChildProcess {
		spawnState.args = args;
		const child = Object.assign(new EventEmitter(), {
			connected: true,
			disconnect: vi.fn(),
			kill: vi.fn(),
			send: vi.fn(),
		});
		spawnState.child = child;
		return child as unknown as ChildProcess;
	},
}));

import { DaemonCatalogClient, isDaemonCatalogSourcePath } from "../src/modes/daemon/daemon-catalog-process.js";

afterEach(() => {
	vi.useRealTimers();
	spawnState.args = [];
	spawnState.child = undefined;
});

describe("daemon catalog startup", () => {
	it("does not mistake an ancestor src directory for the package source tree", () => {
		const packageDir = "/usr/src/app/packages/coding-agent";

		expect(isDaemonCatalogSourcePath(`${packageDir}/dist/modes/daemon/daemon-catalog-process.js`, packageDir)).toBe(
			false,
		);
		expect(isDaemonCatalogSourcePath(`${packageDir}/src/modes/daemon/daemon-catalog-process.ts`, packageDir)).toBe(
			true,
		);
	});

	it("uses the dedicated entrypoint and allows a cold start past five seconds", async () => {
		vi.useFakeTimers();
		const client = new DaemonCatalogClient(() => {});
		const starting = client.start();

		expect(spawnState.args.some((arg) => /daemon-catalog-entry\.(?:js|ts)$/.test(arg))).toBe(true);
		await vi.advanceTimersByTimeAsync(6000);
		spawnState.child?.emit("message", { type: "ready" });
		await expect(starting).resolves.toBeUndefined();
	});

	it("loads TypeScript through a file URL, including Windows paths with spaces", async () => {
		vi.useFakeTimers();
		const client = new DaemonCatalogClient(() => {});
		const starting = client.start();
		spawnState.child?.emit("message", { type: "ready" });
		await starting;

		const loaderPath = createRequire(import.meta.url).resolve("tsx");
		const importIndex = spawnState.args.lastIndexOf("--import");
		expect(importIndex).toBeGreaterThanOrEqual(0);
		expect(spawnState.args[importIndex + 1]).toBe(pathToFileURL(loaderPath).href);
	});

	it("rejects immediately when the catalog exits during startup", async () => {
		vi.useFakeTimers();
		const client = new DaemonCatalogClient(() => {});
		const starting = client.start();

		spawnState.child?.emit("exit", 1, null);
		await expect(starting).rejects.toThrow(/exited during startup/);
	});
});
