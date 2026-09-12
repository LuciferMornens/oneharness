/**
 * Real-process proof that concurrent Prime Agent sessions share one daemon
 * supervisor and one PRIME_AGENT_KERNEL_PYTHON override while each session
 * runs its own Python kernel process.
 *
 * Spawns the real CLI (`--mode json`) several times at once against one
 * isolated agent dir. Each run drives a faux model that calls the ipython tool
 * once and then reports its worker identity, so the JSON event stream carries
 * the whole process chain: supervisor -> worker -> kernel. The worker's parent
 * is the supervisor; the kernel names its owning worker through the
 * PRIME_AGENT_KERNEL_OWNER_PID contract because a Windows venv launcher sits
 * between the worker and the interpreter. Every kernel waits at a file
 * barrier until all expected kernels have arrived, so distinct pids alone
 * cannot pass: the kernels must execute at the same time.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import { kernelVenvPython, resolveKernelVenvDirSync } from "../../src/core/kernel/bootstrap.js";
import { DaemonClient } from "../../src/modes/daemon/daemon-client.js";
import { canonicalizeDaemonFilesystemPath, normalizeSocketPath } from "../../src/modes/daemon/daemon-socket.js";
import {
	listDaemonSupervisorProcesses,
	resolveDaemonSupervisorRegistryDir,
} from "../../src/modes/daemon/daemon-supervisor-ownership.js";
import { isolatedDaemonProcessEnv, isolatedDaemonRegistryDir, removeTempRoot } from "../isolated-daemon-env.js";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../node_modules/tsx/dist/cli.mjs");
const repoTsconfigPath = resolve(__dirname, "../../../../tsconfig.json");
const fauxExtensionPath = resolve(__dirname, "../fixtures/daemon-kernel-concurrency-faux-extension.ts");

const CONCURRENT_SESSION_COUNT = 4;
// Concurrent tsx startups on Windows are slow, so each CLI run gets a long budget.
const CLI_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 240_000;
const CHILD_EXIT_GRACE_MS = 10_000;
const DAEMON_CONNECT_TIMEOUT_MS = 2000;
const DAEMON_REQUEST_TIMEOUT_MS = 5000;
const SOCKET_GONE_POLL_ATTEMPTS = 50;
const SOCKET_GONE_POLL_MS = 20;

const children = new Set<ChildProcess>();
const daemonSockets = new Set<string>();
const tempRoots = new Set<string>();

function resolveReplPython(): string | null {
	const candidates = [process.env.PRIME_AGENT_KERNEL_PYTHON, kernelVenvPython(resolveKernelVenvDirSync())].filter(
		(candidate): candidate is string => Boolean(candidate),
	);
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const replPython = resolveReplPython();

function normalizeExecutablePath(path: string): string {
	const forwardSlashes = path.replaceAll("\\", "/");
	return process.platform === "win32" ? forwardSlashes.toLowerCase() : forwardSlashes;
}

function daemonSocketPathFor(root: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\prime-agent-kernel-concurrency-${process.pid}-${randomUUID().slice(0, 8)}`;
	}
	return join(root, "daemon.sock");
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveExit) => {
		const timeout = setTimeout(() => resolveExit(), CHILD_EXIT_GRACE_MS);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

async function killLiveChildren(): Promise<void> {
	const liveChildren = [...children];
	children.clear();
	for (const child of liveChildren) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
	await Promise.all(liveChildren.map((child) => waitForChildExit(child)));
}

async function shutdownDaemon(socketPath: string): Promise<void> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(DAEMON_CONNECT_TIMEOUT_MS);
		await client.request({ type: "shutdown" }, DAEMON_REQUEST_TIMEOUT_MS);
	} catch {
		// The process may have exited before publishing its socket.
	} finally {
		client.close();
	}
	for (let attempt = 0; attempt < SOCKET_GONE_POLL_ATTEMPTS && existsSync(socketPath); attempt++) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, SOCKET_GONE_POLL_MS));
	}
}

afterEach(async () => {
	await killLiveChildren();
	for (const socketPath of daemonSockets) {
		await shutdownDaemon(socketPath);
	}
	daemonSockets.clear();
	for (const root of tempRoots) {
		await removeTempRoot(root);
	}
	tempRoots.clear();
});

interface CliRunOptions {
	agentDir: string;
	cwd: string;
	environment: NodeJS.ProcessEnv;
}

interface CliRunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

function awaitCliExit(child: ChildProcess, readStderr: () => string): Promise<Pick<CliRunResult, "code" | "signal">> {
	return new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI timed out\n${readStderr()}`));
		}, CLI_TIMEOUT_MS);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal: signal as NodeJS.Signals | null });
		});
	});
}

async function runCli(args: string[], options: CliRunOptions): Promise<CliRunResult> {
	const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
		cwd: options.cwd,
		env: isolatedDaemonProcessEnv({
			TSX_TSCONFIG_PATH: repoTsconfigPath,
			[ENV_AGENT_DIR]: options.agentDir,
			PI_SKIP_VERSION_CHECK: "1",
			PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "0",
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR: isolatedDaemonRegistryDir(options.agentDir),
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SELECTED_REGISTRY_DIR: isolatedDaemonRegistryDir(options.agentDir),
			RLM_DEPTH: "0",
			...options.environment,
		}),
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.stdin?.end("");
	const exit = await awaitCliExit(child, () => stderr);
	children.delete(child);
	return { ...exit, stdout, stderr };
}

interface ContentBlock {
	type: string;
	text?: string;
}

interface SessionEvent {
	type: string;
	toolName?: string;
	result?: { content?: ContentBlock[] };
	message?: { role: string; content?: ContentBlock[] | string };
}

function parseSessionEvents(stdout: string): SessionEvent[] {
	return stdout
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as SessionEvent);
}

function firstText(blocks: ContentBlock[] | string | undefined): string | undefined {
	if (typeof blocks === "string") return blocks;
	return blocks?.find((block) => block.type === "text")?.text;
}

function ipythonResultText(events: SessionEvent[]): string {
	const toolEnd = events.find((event) => event.type === "tool_execution_end" && event.toolName === "ipython");
	expect(toolEnd, "ipython tool_execution_end missing from the JSON event stream").toBeDefined();
	const text = firstText(toolEnd?.result?.content);
	expect(text, "ipython result has no text block").toBeDefined();
	return text as string;
}

function finalAssistantText(events: SessionEvent[]): string {
	const assistantTexts = events
		.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.map((event) => firstText(event.message?.content))
		.filter((text): text is string => text !== undefined);
	expect(assistantTexts.length, "no assistant text in the JSON event stream").toBeGreaterThan(0);
	return assistantTexts[assistantTexts.length - 1] as string;
}

interface ProcessChain {
	kernelPid: number;
	kernelOwnerPid: number;
	/** Kernels registered at the barrier when this kernel stopped waiting. */
	barrierArrived: number;
	python: string;
	workerPid: number;
	supervisorPid: number;
}

function parseProcessChain(stdout: string): ProcessChain {
	const events = parseSessionEvents(stdout);
	const kernelText = ipythonResultText(events);
	const kernelMatch = /KERNEL_PID=(\d+) KERNEL_OWNER_PID=(\d+) BARRIER_ARRIVED=(\d+) PY=(.+)/.exec(kernelText);
	expect(kernelMatch, `kernel identity missing from ipython result:\n${kernelText}`).not.toBeNull();
	const workerText = finalAssistantText(events);
	const workerMatch = /WORKER_PID=(\d+) SUPERVISOR_PID=(\d+)/.exec(workerText);
	expect(workerMatch, `worker identity missing from the final assistant text:\n${workerText}`).not.toBeNull();
	return {
		kernelPid: Number(kernelMatch?.[1]),
		kernelOwnerPid: Number(kernelMatch?.[2]),
		barrierArrived: Number(kernelMatch?.[3]),
		python: (kernelMatch?.[4] ?? "").trim(),
		workerPid: Number(workerMatch?.[1]),
		supervisorPid: Number(workerMatch?.[2]),
	};
}

interface DaemonFixture {
	agentDir: string;
	root: string;
	socketPath: string;
}

/** Every kernel of the fixture waits at `<root>/barrier` until `expectedKernels` have arrived. */
function createDaemonFixture(expectedKernels: number): DaemonFixture {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-kernel-concurrency-"));
	chmodSync(root, 0o700);
	tempRoots.add(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const barrierDir = join(root, "barrier");
	mkdirSync(barrierDir, { recursive: true });
	writeFileSync(join(barrierDir, "expected"), String(expectedKernels));
	const socketPath = daemonSocketPathFor(root);
	daemonSockets.add(socketPath);
	return { agentDir, root, socketPath };
}

async function runKernelSession(fixture: DaemonFixture, index: number): Promise<ProcessChain> {
	const cwd = join(fixture.root, `cwd-${index}`);
	mkdirSync(cwd, { recursive: true });
	const result = await runCli(
		[
			"--mode",
			"json",
			"--daemon-socket",
			fixture.socketPath,
			"--model",
			"faux/faux",
			"--extension",
			fauxExtensionPath,
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"Run the code",
		],
		{
			agentDir: fixture.agentDir,
			cwd,
			environment: { PRIME_AGENT_KERNEL_PYTHON: replPython as string },
		},
	);
	expect(result, `run ${index} failed:\n${result.stderr}`).toMatchObject({ code: 0, signal: null });
	expect(result.stderr).not.toContain("Timed out waiting for daemon");
	return parseProcessChain(result.stdout);
}

async function readSupervisorPidFromHello(socketPath: string): Promise<number | undefined> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(DAEMON_CONNECT_TIMEOUT_MS);
		const hello = await client.waitForHello(DAEMON_REQUEST_TIMEOUT_MS);
		return hello.supervisorPid;
	} finally {
		client.close();
	}
}

/**
 * The CLI launches the supervisor with the registry override env scrubbed, so
 * the supervisor publishes its owner record in the platform default registry.
 */
async function expectSingleSupervisor(fixture: DaemonFixture, chains: ProcessChain[]): Promise<void> {
	const supervisorPids = new Set(chains.map((chain) => chain.supervisorPid));
	expect(supervisorPids.size, "workers reported different supervisor pids").toBe(1);
	const [supervisorPid] = supervisorPids;

	const registryDir = resolveDaemonSupervisorRegistryDir(isolatedDaemonProcessEnv());
	const owners = (await listDaemonSupervisorProcesses(registryDir)).filter(
		(owner) => owner.socketPath === normalizeSocketPath(fixture.socketPath),
	);
	expect(owners).toHaveLength(1);
	expect(owners[0]).toMatchObject({
		pid: supervisorPid,
		agentDir: canonicalizeDaemonFilesystemPath(fixture.agentDir),
	});

	await expect(readSupervisorPidFromHello(fixture.socketPath)).resolves.toBe(supervisorPid);
}

function expectKernelOnOverridePython(chain: ProcessChain, expectedKernels: number): void {
	expect(chain.kernelPid).toBeGreaterThan(0);
	expect(chain.kernelOwnerPid).toBe(chain.workerPid);
	// A kernel only leaves the barrier once every expected kernel has registered,
	// so a full count proves the kernels were alive at the same time.
	expect(chain.barrierArrived, "kernel left the barrier before every kernel arrived").toBe(expectedKernels);
	expect(normalizeExecutablePath(chain.python)).toBe(normalizeExecutablePath(replPython as string));
}

const describeWithKernel = replPython ? describe : describe.skip;

describeWithKernel(
	"Real-process daemon sessions share one supervisor and get separate kernels",
	{ tags: ["kernel-heavy"] },
	() => {
		it(
			"runs one session with its kernel on the override python",
			async () => {
				const fixture = createDaemonFixture(1);
				const chain = await runKernelSession(fixture, 0);
				expectKernelOnOverridePython(chain, 1);
				await expectSingleSupervisor(fixture, [chain]);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"runs concurrent sessions on one supervisor and one python with a kernel per session",
			async () => {
				const fixture = createDaemonFixture(CONCURRENT_SESSION_COUNT);
				const chains = await Promise.all(
					Array.from({ length: CONCURRENT_SESSION_COUNT }, (_, index) => runKernelSession(fixture, index)),
				);
				for (const chain of chains) {
					expectKernelOnOverridePython(chain, CONCURRENT_SESSION_COUNT);
				}
				expect(new Set(chains.map((chain) => chain.kernelPid)).size).toBe(CONCURRENT_SESSION_COUNT);
				expect(new Set(chains.map((chain) => chain.workerPid)).size).toBe(CONCURRENT_SESSION_COUNT);
				await expectSingleSupervisor(fixture, chains);
			},
			TEST_TIMEOUT_MS,
		);
	},
);
