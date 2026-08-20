import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	cleanupDaemonSocketPath,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	normalizeSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";

describe("normalizeSocketPath", () => {
	it("normalizes equivalent Unix spellings", () => {
		if (process.platform === "win32") return;
		expect(normalizeSocketPath("/a//b.sock/")).toBe("/a/b.sock");
	});

	it("lowercases Windows socket identity", () => {
		if (process.platform !== "win32") return;
		expect(normalizeSocketPath("\\\\.\\Pipe\\Prime-Agent-Daemon")).toBe("\\\\.\\pipe\\prime-agent-daemon");
	});
});

describe("defaultDaemonSocketPath", () => {
	it("discovers the original Windows pipe for a live identity-less legacy worker", async () => {
		if (process.platform !== "win32") {
			return;
		}
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-legacy-pipe-"));
		const supervisorSocketPath = "\\\\.\\pipe\\prime-agent-daemon";
		const workerSocketPath = `\\\\.\\pipe\\prime-agent-legacy-worker-${process.pid}-${Date.now()}`;
		const descriptorDir = join(
			agentDir,
			"daemon-workers",
			createHash("sha256").update(supervisorSocketPath).digest("hex").slice(0, 12),
		);
		mkdirSync(descriptorDir, { recursive: true });
		writeFileSync(
			join(descriptorDir, "supervisor-config"),
			JSON.stringify({
				version: 1,
				socketPath: supervisorSocketPath,
				defaultSessionConfig: { agentDir },
			}),
		);
		const descriptorPath = join(descriptorDir, "legacy-worker.json");
		const legacyDescriptor = {
			pid: process.pid,
			socketPath: workerSocketPath,
			authenticationToken: "legacy-worker-token",
			supervisorSocketPath,
		};
		writeFileSync(descriptorPath, JSON.stringify(legacyDescriptor));
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		const workerServer = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				workerServer.once("error", reject);
				workerServer.listen(workerSocketPath, resolve);
			});
			process.env[ENV_AGENT_DIR] = agentDir;
			expect(defaultDaemonSocketPath()).toBe(supervisorSocketPath);
			await new Promise<void>((resolve) => workerServer.close(() => resolve()));
			// The descriptor remains a migration target even when its identity-less
			// pid was reused after the legacy worker pipe disappeared.
			expect(defaultDaemonSocketPath()).toBe(supervisorSocketPath);
			writeFileSync(descriptorPath, JSON.stringify({ ...legacyDescriptor, pid: 2_147_483_647 }));
			expect(defaultDaemonSocketPath()).toBe(supervisorSocketPath);
		} finally {
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
			if (workerServer.listening) {
				await new Promise<void>((resolve) => workerServer.close(() => resolve()));
			}
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("uses a per-user Unix socket directory", () => {
		if (process.platform === "win32") {
			return;
		}

		const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
		const socketPath = defaultDaemonSocketPath();

		expect(dirname(socketPath)).toBe(join(tmpdir(), `prime-agent-${suffix}`));
		expect(basename(socketPath)).toBe("daemon.sock");
	});

	it("checks a live daemon before acquiring the socket path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-live-"));
		const socketPath = join(dir, "daemon.sock");
		let observedLock: boolean | undefined;
		const server = createServer((socket) => {
			observedLock = existsSync(`${socketPath}.lock`);
			socket.destroy();
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(/socket already in use/i);
			expect(observedLock).toBe(false);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not wait on a stale lock when no socket path exists", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-stale-lock-"));
		const socketPath = join(dir, "daemon.sock");
		mkdirSync(`${socketPath}.lock`);
		let prepared = false;
		try {
			await Promise.race([
				prepareDaemonSocketPath(socketPath).then(() => {
					prepared = true;
				}),
				new Promise<void>((resolve) => setTimeout(resolve, 250)),
			]);
			expect(prepared).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a replacement daemon's socket during delayed cleanup", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-ownership-"));
		const socketPath = join(dir, "daemon.sock");
		const oldServer = createServer();
		const replacementServer = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				oldServer.once("error", reject);
				oldServer.listen(socketPath, resolve);
			});
			const oldIdentity = getDaemonSocketIdentity(socketPath);
			if (!oldIdentity) {
				throw new Error("Expected a Unix daemon socket identity");
			}

			unlinkSync(socketPath);
			await new Promise<void>((resolve, reject) => {
				replacementServer.once("error", reject);
				replacementServer.listen(socketPath, resolve);
			});

			cleanupDaemonSocketPath(socketPath, oldIdentity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await Promise.all(
				[oldServer, replacementServer].map(
					(server) =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
						}),
				),
			);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a socket while another daemon owns the path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-lock-"));
		const socketPath = join(dir, "daemon.sock");
		const server = createServer();
		let releaseLock: (() => Promise<void>) | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			const identity = getDaemonSocketIdentity(socketPath);
			if (!identity) {
				throw new Error("Expected a Unix daemon socket identity");
			}
			releaseLock = await lockfile.lock(socketPath, { realpath: false });

			cleanupDaemonSocketPath(socketPath, identity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await releaseLock?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not remove a replacement socket that appears while stale cleanup is pending", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-startup-"));
		const socketPath = join(dir, "daemon.sock");
		const staleOwner = spawn(
			process.execPath,
			[
				"-e",
				"const { createServer } = require('node:net'); const server = createServer(); server.listen(process.argv[1], () => process.stdout.write('ready'));",
				socketPath,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const replacementServer = createServer();
		let replacementTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				staleOwner.stdout?.once("data", () => resolve());
				staleOwner.once("error", reject);
				staleOwner.once("exit", (code) => {
					if (code !== null && code !== 0) {
						reject(new Error(`Stale socket owner exited before listening: ${code}`));
					}
				});
			});
			staleOwner.kill("SIGKILL");
			await new Promise<void>((resolve) => staleOwner.once("close", () => resolve()));
			expect(existsSync(socketPath)).toBe(true);

			const replacementListening = new Promise<void>((resolve, reject) => {
				replacementTimer = setTimeout(() => {
					try {
						if (existsSync(socketPath)) {
							unlinkSync(socketPath);
						}
						replacementServer.once("error", reject);
						replacementServer.listen(socketPath, resolve);
					} catch (error) {
						reject(error);
					}
				}, 50);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(
				/socket (already in use|changed ownership)/i,
			);
			await replacementListening;
			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			if (replacementTimer) {
				clearTimeout(replacementTimer);
			}
			if (staleOwner.exitCode === null && staleOwner.signalCode === null) {
				staleOwner.kill("SIGKILL");
			}
			if (replacementServer.listening) {
				await new Promise<void>((resolve) => replacementServer.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
