import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { execCommand } from "../src/core/exec.js";
import type { KernelClient } from "../src/core/kernel/index.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { type Settings, SettingsManager } from "../src/core/settings-manager.js";
import { createLocalBashOperations } from "../src/core/tools/bash.js";
import { createIpythonTool, IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import { waitForHeadlessCompletion } from "../src/modes/headless-completion.js";
import * as shellModule from "../src/utils/shell.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const WINDOWS_COMMAND_TERMINATION_SETTLE_MS = 31_000;

function usage(): Usage {
	return {
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
	};
}

function streamAnswer(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
	});
	return stream;
}

function userText(context: Context): string {
	const lastMessage = context.messages[context.messages.length - 1] as AgentMessage | undefined;
	if (!lastMessage || (lastMessage.role !== "user" && lastMessage.role !== "custom")) return "";
	if (typeof lastMessage.content === "string") return lastMessage.content;
	return lastMessage.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

interface InspectableRlmRun {
	settled: boolean;
	status: string;
	settlement?: { promise: Promise<void> };
}

interface InspectableRlmSession {
	_activeRlmChildRuns: Map<string, InspectableRlmRun>;
	_unsettledRlmChildRuns: Set<InspectableRlmRun>;
}

function hangState<T>(promise: Promise<T>): { settled: boolean } {
	const state = { settled: false };
	void promise.then(
		() => {
			state.settled = true;
		},
		() => {
			state.settled = true;
		},
	);
	return state;
}

async function outcomeWithin<T>(promise: Promise<T>, ms: number): Promise<"settled" | "pending"> {
	const state = hangState(promise);
	await Promise.race([promise.catch(() => undefined), sleep(ms)]);
	return state.settled ? "settled" : "pending";
}

function killPid(pid: number): void {
	try {
		if (process.platform === "win32") {
			execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
		} else {
			process.kill(pid, "SIGKILL");
		}
	} catch {
		// Already gone.
	}
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`Child did not write ${path}`);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function readPid(path: string): number {
	const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid pid in ${path}`);
	return pid;
}

function createSession(
	tempDir: string,
	options: {
		depth?: number;
		maxDepth?: number;
		rlmSessionDir?: string;
		streamFn?: StreamFn;
		settingsOverrides?: Partial<Settings>;
		subagentRuntimeHost?: ConstructorParameters<typeof AgentSession>[0]["subagentRuntimeHost"];
	} = {},
): AgentSession {
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const agent = new Agent({
		convertToLlm,
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
		streamFn: options.streamFn ?? ((_model, context) => streamAnswer(`child answer: ${userText(context)}`)),
	});
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	if (options.settingsOverrides) settingsManager.applyOverrides(options.settingsOverrides);
	return new AgentSession({
		agent,
		sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		settingsManager,
		cwd: tempDir,
		modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
		resourceLoader: createTestResourceLoader(),
		subagentRuntimeHost: options.subagentRuntimeHost,
		rlmDepth: options.depth,
		rlmMaxDepth: options.maxDepth,
		rlmSessionDir: options.rlmSessionDir,
	});
}

describe("subagent timeout hang", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe("IPython user-cell execute", () => {
		it("ipython tool execute does not wrap the kernel cell in a timeout", async () => {
			const provisioner = new IpythonKernelProvisioner(process.cwd());
			const execute = vi.fn(
				(_code: string, _opts?: { signal?: AbortSignal; stallTimeoutMs?: number }) => new Promise<never>(() => {}),
			);
			vi.spyOn(provisioner, "ensure").mockResolvedValue({ execute } as unknown as KernelClient);
			const tool = createIpythonTool(process.cwd(), { provisioner });
			const signal = new AbortController().signal;

			const toolPromise = tool.execute("tool-hang", { code: "import time; time.sleep(10 ** 9)" }, signal);
			const state = hangState(toolPromise);
			await vi.waitFor(() => expect(execute).toHaveBeenCalled());

			const executeOpts = execute.mock.calls[0]?.[1];
			expect(executeOpts).toMatchObject({ signal });
			expect(executeOpts).not.toHaveProperty("executionTimeoutMs");
			expect(executeOpts?.stallTimeoutMs).toBeUndefined();
			expect(await outcomeWithin(toolPromise, 200)).toBe("pending");
			expect(state.settled).toBe(false);
		});

		it("ipython tool forwards stallTimeoutMs to kernel execute", async () => {
			const provisioner = new IpythonKernelProvisioner(process.cwd());
			const execute = vi.fn((_code: string, _opts?: { stallTimeoutMs?: number }) => new Promise<never>(() => {}));
			vi.spyOn(provisioner, "ensure").mockResolvedValue({ execute } as unknown as KernelClient);
			const tool = createIpythonTool(process.cwd(), { provisioner, stallTimeoutMs: () => 12_000 });
			void tool.execute("tool-stall", { code: "pass" });
			await vi.waitFor(() => expect(execute).toHaveBeenCalled());
			expect(execute.mock.calls[0]?.[1]?.stallTimeoutMs).toBe(12_000);
		});
	});

	describe("bash / exec timeout", () => {
		let testDir: string;
		const livePids: number[] = [];

		beforeEach(() => {
			testDir = join(tmpdir(), `subagent-timeout-hang-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(testDir, { recursive: true });
			livePids.length = 0;
		});

		afterEach(() => {
			for (const pid of livePids) killPid(pid);
			rmSync(testDir, { recursive: true, force: true });
		});

		it("bash timeout returns a tool error when the child can be killed", async () => {
			const bash = createLocalBashOperations();
			const result = bash.exec(
				`${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(()=>{}, 30000)")}`,
				testDir,
				{
					onData: () => {},
					timeout: 1,
				},
			);
			await expect(result).rejects.toThrow(/timeout:1/);
		});

		it("exec timeout against a SIGTERM-insensitive child still settles when tree kill works", async () => {
			const readyFile = join(testDir, "exec-ready");
			const resultPromise = execCommand(
				process.execPath,
				[
					"-e",
					`const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`,
					readyFile,
				],
				testDir,
				{ timeout: 1000 },
			);
			await waitForFile(readyFile);
			livePids.push(readPid(readyFile));
			const result = await resultPromise;
			expect(result.killed || result.code !== 0).toBe(true);
		});

		it("has no default bash timeout, so an untimed command stays pending", async () => {
			const controller = new AbortController();
			const bash = createLocalBashOperations();
			const execPromise = bash.exec(
				`${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(()=>{}, 30000)")}`,
				testDir,
				{ onData: () => {}, signal: controller.signal },
			);
			const state = hangState(execPromise);
			expect(await outcomeWithin(execPromise, 250)).toBe("pending");
			expect(state.settled).toBe(false);
			controller.abort();
			await execPromise.catch(() => undefined);
		});

		it("when tree kill never completes, only Windows fail-opens the bash timeout", async () => {
			vi.spyOn(shellModule, "killProcessTreeByIdentity").mockImplementation(() => new Promise<boolean>(() => {}));
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

			const readyFile = join(testDir, "kill-hang-ready");
			const execPromise = execCommand(
				process.execPath,
				[
					"-e",
					`const { writeFileSync } = require("node:fs"); writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`,
					readyFile,
				],
				testDir,
				{ timeout: 50 },
			);
			await waitForFile(readyFile);
			livePids.push(readPid(readyFile));
			const state = hangState(execPromise);

			await vi.advanceTimersByTimeAsync(50);
			await Promise.resolve();
			expect(state.settled).toBe(false);

			await vi.advanceTimersByTimeAsync(WINDOWS_COMMAND_TERMINATION_SETTLE_MS);
			await Promise.resolve();
			await Promise.resolve();

			if (process.platform === "win32") {
				expect(state.settled).toBe(true);
				const result = await execPromise;
				expect(result.code).toBe(1);
			} else {
				expect(state.settled).toBe(false);
			}
		});
	});

	describe("RLM child live / quiescence waiters", () => {
		let tempDir: string;
		const sessions: AgentSession[] = [];

		beforeEach(() => {
			tempDir = join(tmpdir(), `subagent-rlm-hang-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(tempDir, { recursive: true });
			sessions.length = 0;
		});

		afterEach(() => {
			for (const session of sessions) session.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("does not fail-open after an inner tool stays live: run never settles and parent gets no terminal result", async () => {
			const childDir = join(tempDir, "child");
			mkdirSync(childDir, { recursive: true });
			let childStarted = false;
			let releaseChild = () => {};
			const childGate = new Promise<void>((resolve) => {
				releaseChild = resolve;
			});
			const child = createSession(childDir, {
				depth: 1,
				rlmSessionDir: join(childDir, "rlm"),
				streamFn: () => {
					childStarted = true;
					const stream = createAssistantMessageEventStream();
					void childGate.then(() => {
						stream.push({
							type: "done",
							reason: "stop",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "first turn" }],
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage: usage(),
								stopReason: "stop",
								timestamp: Date.now(),
							},
						});
					});
					return stream;
				},
			});
			sessions.push(child);

			const rootDir = join(tempDir, "root");
			mkdirSync(rootDir, { recursive: true });
			const root = createSession(rootDir, {
				maxDepth: 1,
				rlmSessionDir: join(rootDir, "rlm"),
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child }),
					deleteRlmSubagentRuntime: async () => {},
				},
			});
			sessions.push(root);

			const spawned = await root.runRlmChild("do work that times out", { name: "stuck-worker" });
			await vi.waitFor(() => expect(childStarted).toBe(true));

			let releaseBash = () => {};
			const bashGate = new Promise<void>((resolve) => {
				releaseBash = resolve;
			});
			const bash = child.executeBash("inner-timeout-hang", undefined, {
				operations: {
					exec: async () => {
						await bashGate;
						return { exitCode: 0 };
					},
				},
			});
			await vi.waitFor(() => expect(child.hasLiveRlmSessionWork()).toBe(true));
			releaseChild();
			await vi.waitFor(() => expect(child.getLastAssistantText()).toBe("first turn"));

			const internals = root as unknown as InspectableRlmSession;
			const run = internals._activeRlmChildRuns.get(spawned.rlm_child_id);
			expect(run).toBeDefined();
			expect(run?.status).toBe("running");
			expect(run?.settled).toBe(false);
			expect(root.getRlmChildRunStatus(spawned.rlm_child_id)).toBe("running");
			expect(
				root.messages.filter(
					(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
				),
			).toHaveLength(0);

			const quiescence = root.waitForRlmQuiescence();
			const headless = waitForHeadlessCompletion(root, { waitForRlmQuiescence: true });
			expect(await outcomeWithin(quiescence, 400)).toBe("pending");
			expect(await outcomeWithin(headless, 200)).toBe("pending");
			expect(run?.settled).toBe(false);
			expect(internals._unsettledRlmChildRuns.has(run!)).toBe(true);

			releaseBash();
			await bash;
			await expect(quiescence).resolves.toBeUndefined();
			await expect(headless).resolves.toBeDefined();
		});

		it("fail-opens a silent RLM child tool wait and delivers a parent-visible cancelled result", async () => {
			const childDir = join(tempDir, "child-fail-open");
			mkdirSync(childDir, { recursive: true });
			const settingsOverrides = { inactivityTimeoutMs: 100 };
			let childStarted = false;
			let releaseChild = () => {};
			const childGate = new Promise<void>((resolve) => {
				releaseChild = resolve;
			});
			const child = createSession(childDir, {
				depth: 1,
				rlmSessionDir: join(childDir, "rlm"),
				settingsOverrides,
				streamFn: () => {
					childStarted = true;
					const stream = createAssistantMessageEventStream();
					void childGate.then(() => {
						stream.push({
							type: "done",
							reason: "stop",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "first turn" }],
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage: usage(),
								stopReason: "stop",
								timestamp: Date.now(),
							},
						});
					});
					return stream;
				},
			});
			sessions.push(child);

			const rootDir = join(tempDir, "root-fail-open");
			mkdirSync(rootDir, { recursive: true });
			const root = createSession(rootDir, {
				maxDepth: 1,
				rlmSessionDir: join(rootDir, "rlm"),
				settingsOverrides,
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child }),
					deleteRlmSubagentRuntime: async () => {},
				},
			});
			sessions.push(root);

			await root.runRlmChild("do work that times out", { name: "fail-open-worker" });
			await vi.waitFor(() => expect(childStarted).toBe(true));

			const bash = child.executeBash("silent-hang", undefined, {
				operations: {
					exec: async (_command, _cwd, { signal }) => {
						await new Promise<void>((_resolve, reject) => {
							if (signal?.aborted) {
								reject(new Error("aborted"));
								return;
							}
							signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						});
						return { exitCode: 0 };
					},
				},
			});
			await vi.waitFor(() => expect(child.isBashRunning).toBe(true));
			releaseChild();
			await vi.waitFor(() => expect(child.getLastAssistantText()).toBe("first turn"));

			await vi.waitFor(() => {
				expect(
					root.messages.some(
						(message) =>
							message.role === "custom" &&
							typeof message.content === "string" &&
							message.content.includes("stalled"),
					),
				).toBe(true);
			});
			await expect(bash).resolves.toMatchObject({ cancelled: true });
			await expect(root.waitForRlmQuiescence()).resolves.toBeUndefined();
		});
	});
});
