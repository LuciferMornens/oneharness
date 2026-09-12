import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import { getPackageDir, isBunBinary } from "../../config.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import { deleteSessionFile } from "../../core/session-file-actions.js";
import { readSessionInfo, type SessionInfo, SessionManager } from "../../core/session-manager.js";
import { spawnHidden, waitForChildProcess } from "../../utils/child-process.js";
import {
	killProcessTreeByIdentity,
	reconcileTrackedDetachedChildAfterExit,
	trackChildProcess,
} from "../../utils/shell.js";
import { DAEMON_CATALOG_ROLE_ENV } from "./daemon-role-env.js";

export { DAEMON_CATALOG_ROLE_ENV };

const CATALOG_IDLE_TIMEOUT_MS = 30_000;
const CATALOG_SHUTDOWN_TIMEOUT_MS = 2000;
const DAEMON_CATALOG_START_TIMEOUT_MS = 30_000;

export function isDaemonCatalogSourcePath(modulePath: string, packageDir: string): boolean {
	return resolve(modulePath).startsWith(`${resolve(packageDir, "src")}${sep}`);
}

function resolveDaemonCatalogEntrypoint(): string {
	const packageDir = getPackageDir();
	const sourceEntrypoint = join(packageDir, "src", "modes", "daemon", "daemon-catalog-entry.ts");
	const compiledEntrypoint = join(packageDir, "dist", "modes", "daemon", "daemon-catalog-entry.js");
	const runningFromSource = isDaemonCatalogSourcePath(fileURLToPath(import.meta.url), packageDir);
	const candidates = runningFromSource
		? [sourceEntrypoint, compiledEntrypoint]
		: [compiledEntrypoint, sourceEntrypoint];
	const entrypoint = candidates.find((candidate) => existsSync(candidate));
	if (entrypoint) return entrypoint;
	throw new Error("Cannot locate the daemon catalog entrypoint");
}

interface SessionInfoWire extends Omit<SessionInfo, "created" | "modified"> {
	created: string;
	modified: string;
}

type CatalogRequest =
	| { type: "request"; id: string; command: "list"; cwd?: string; sessionDir?: string }
	| { type: "request"; id: string; command: "resolve"; selector: string; cwd: string; sessionDir?: string }
	| { type: "request"; id: string; command: "rename"; sessionPath: string; name: string }
	| { type: "request"; id: string; command: "delete"; sessionPath: string }
	| { type: "request"; id: string; command: "archive"; sessionPath: string; sessionId: string }
	| {
			type: "request";
			id: string;
			command: "mark_interrupted";
			sessionPath: string;
			activeSessionId: string;
			operations: string[];
			recoveryId: string;
	  }
	| { type: "request"; id: string; command: "shutdown" };

type CatalogOutbound =
	| { type: "ready" }
	| { type: "progress"; id: string; loaded: number; total: number }
	| { type: "session"; id: string; session: SessionInfoWire }
	| { type: "response"; id: string; success: true; data?: unknown }
	| { type: "response"; id: string; success: false; error: string };

interface CatalogListCallbacks {
	onProgress?: (loaded: number, total: number) => void;
	onSession?: (session: SessionInfo) => void;
}

function serializeSessionInfo(session: SessionInfo): SessionInfoWire {
	return {
		...session,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
	};
}

function deserializeSessionInfo(session: SessionInfoWire): SessionInfo {
	return {
		...session,
		created: new Date(session.created),
		modified: new Date(session.modified),
	};
}

export function resolveCatalogSessionMatch(
	sessions: readonly SessionInfo[],
	selector: string,
): SessionInfo | undefined {
	const matches = sessions.filter((session) => session.id.startsWith(selector) || session.name === selector);
	if (matches.length > 1) {
		throw new Error(`Ambiguous session selector "${selector}"`);
	}
	return matches[0];
}

function isCatalogOutbound(value: unknown): value is CatalogOutbound {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown };
	return (
		candidate.type === "ready" ||
		((candidate.type === "progress" || candidate.type === "session" || candidate.type === "response") &&
			typeof candidate.id === "string")
	);
}

function isCatalogRequest(value: unknown): value is CatalogRequest {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown; command?: unknown };
	return (
		candidate.type === "request" &&
		typeof candidate.id === "string" &&
		(candidate.command === "list" ||
			candidate.command === "resolve" ||
			candidate.command === "rename" ||
			candidate.command === "delete" ||
			candidate.command === "archive" ||
			candidate.command === "mark_interrupted" ||
			candidate.command === "shutdown")
	);
}

function sendCatalogMessage(message: CatalogOutbound): void {
	if (process.send) {
		process.send(message);
	}
}

export function isDaemonCatalogProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[DAEMON_CATALOG_ROLE_ENV] === "1";
}

export async function runDaemonCatalogProcess(): Promise<never> {
	process.on("disconnect", () => process.exit(0));
	process.on("message", (value: unknown) => {
		if (!isCatalogRequest(value)) {
			return;
		}
		void handleCatalogRequest(value);
	});
	sendCatalogMessage({ type: "ready" });
	return new Promise(() => {});
}

async function handleCatalogRequest(request: CatalogRequest): Promise<void> {
	try {
		switch (request.command) {
			case "list": {
				const callbacks = {
					onProgress: (loaded: number, total: number) =>
						sendCatalogMessage({ type: "progress", id: request.id, loaded, total }),
					onSession: (session: SessionInfo) =>
						sendCatalogMessage({ type: "session", id: request.id, session: serializeSessionInfo(session) }),
				};
				const sessions = request.cwd
					? await SessionManager.list(request.cwd, request.sessionDir, callbacks)
					: await SessionManager.listAll(callbacks, request.sessionDir);
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { sessions: sessions.map(serializeSessionInfo) },
				});
				return;
			}
			case "resolve": {
				const localMatch = resolveCatalogSessionMatch(
					await SessionManager.list(request.cwd, request.sessionDir),
					request.selector,
				);
				if (localMatch) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { sessionPath: localMatch.path },
					});
					return;
				}
				const globalMatch = resolveCatalogSessionMatch(
					await SessionManager.listAll(undefined, request.sessionDir),
					request.selector,
				);
				if (globalMatch) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { sessionPath: globalMatch.path },
					});
					return;
				}
				throw new Error(`No session found matching '${request.selector}'`);
			}
			case "rename":
				SessionManager.open(request.sessionPath).appendSessionInfo(request.name.trim());
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				return;
			case "delete":
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: await deleteSessionFile(request.sessionPath),
				});
				return;
			case "archive": {
				const session = await readSessionInfo(request.sessionPath);
				if (!session || session.id !== request.sessionId) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { archived: false },
					});
					return;
				}
				if (session.state?.status !== "archived") {
					SessionManager.open(request.sessionPath).appendSessionState({ status: "archived" });
				}
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { archived: true },
				});
				return;
			}
			case "mark_interrupted": {
				const session = SessionManager.open(request.sessionPath);
				const alreadyRecorded = session
					.getEntries()
					.some(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "prime-agent.worker_recovery" &&
							entry.details !== null &&
							typeof entry.details === "object" &&
							(entry.details as { activeSessionId?: unknown }).activeSessionId === request.activeSessionId &&
							(entry.details as { recoveryId?: unknown }).recoveryId === request.recoveryId,
					);
				if (!alreadyRecorded) {
					session.appendCustomMessageEntryWithRollback(
						"prime-agent.worker_recovery",
						"<prime_agent_worker_interrupted>\nThe isolated session worker stopped during in-flight work. The saved transcript was recovered, but uncertain model, tool, bash, or child-agent work was not replayed. Inspect external side effects before continuing.\n</prime_agent_worker_interrupted>",
						false,
						{
							activeSessionId: request.activeSessionId,
							operations: request.operations,
							recoveryId: request.recoveryId,
						},
					);
				}
				const descriptor = openSync(request.sessionPath, "r+");
				try {
					fsyncSync(descriptor);
				} finally {
					closeSync(descriptor);
				}
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				return;
			}
			case "shutdown":
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				setImmediate(() => process.exit(0));
				return;
		}
	} catch (error) {
		sendCatalogMessage({
			type: "response",
			id: request.id,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export class DaemonCatalogClient {
	private child?: ChildProcess;
	private readonly childProcessStartIds = new WeakMap<ChildProcess, string | undefined>();
	private starting?: Promise<void>;
	private stopping?: Promise<void>;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private readonly pending = new Map<
		string,
		{
			resolve: (data: unknown) => void;
			reject: (error: Error) => void;
			callbacks?: CatalogListCallbacks;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(private readonly onDiagnostic: (message: string) => void) {}

	async start(): Promise<void> {
		this.clearIdleTimer();
		if (this.stopping) {
			await this.stopping;
		}
		if (this.starting) {
			return this.starting;
		}
		if (this.child?.connected) {
			return;
		}
		this.starting = this.spawnCatalog().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async list(cwd?: string, sessionDir?: string, callbacks?: CatalogListCallbacks): Promise<SessionInfo[]> {
		const data = await this.request<{ sessions: SessionInfoWire[] }>(
			{ type: "request", id: randomUUID(), command: "list", cwd, sessionDir },
			callbacks,
		);
		return data.sessions.map(deserializeSessionInfo);
	}

	async rename(sessionPath: string, name: string): Promise<void> {
		await this.request({ type: "request", id: randomUUID(), command: "rename", sessionPath, name });
	}

	async resolve(selector: string, cwd: string, sessionDir?: string): Promise<string> {
		const data = await this.request<{ sessionPath: string }>({
			type: "request",
			id: randomUUID(),
			command: "resolve",
			selector,
			cwd,
			sessionDir,
		});
		return data.sessionPath;
	}

	delete(sessionPath: string): Promise<DeleteSessionFileResult> {
		return this.request({ type: "request", id: randomUUID(), command: "delete", sessionPath });
	}

	async archive(sessionPath: string, sessionId: string): Promise<boolean> {
		const data = await this.request<{ archived: boolean }>({
			type: "request",
			id: randomUUID(),
			command: "archive",
			sessionPath,
			sessionId,
		});
		return data.archived;
	}

	async markInterrupted(
		sessionPath: string,
		activeSessionId: string,
		operations: string[],
		recoveryId: string,
	): Promise<void> {
		await this.request({
			type: "request",
			id: randomUUID(),
			command: "mark_interrupted",
			sessionPath,
			activeSessionId,
			operations,
			recoveryId,
		});
	}

	async stop(): Promise<void> {
		this.clearIdleTimer();
		if (this.stopping) {
			return this.stopping;
		}
		if (this.starting) {
			await this.starting.catch(() => undefined);
		}
		const child = this.child;
		if (!child) {
			return;
		}
		const stopping = this.stopChild(child);
		const tracked = stopping.finally(() => {
			if (this.stopping === tracked) this.stopping = undefined;
		});
		this.stopping = tracked;
		return tracked;
	}

	private async stopChild(child: ChildProcess): Promise<void> {
		await this.request(
			{ type: "request", id: randomUUID(), command: "shutdown" },
			undefined,
			false,
			CATALOG_SHUTDOWN_TIMEOUT_MS,
		).catch(() => undefined);
		this.clearIdleTimer();
		if (child.connected) child.disconnect();
		let exited = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			waitForChildProcess(child).then(
				() => {
					exited = true;
				},
				() => undefined,
			),
			new Promise<void>((resolveTimeout) => {
				timeout = setTimeout(resolveTimeout, CATALOG_SHUTDOWN_TIMEOUT_MS);
			}),
		]);
		if (timeout) clearTimeout(timeout);
		if (!exited || process.platform !== "win32") await this.terminateChild(child);
		if (this.child === child) this.child = undefined;
	}

	private async spawnCatalog(): Promise<void> {
		let command: string;
		let args: string[];
		let environment = createCliSubprocessEnv({ ...process.env, [DAEMON_CATALOG_ROLE_ENV]: "1" });
		if (isBunBinary) {
			const launch = createCliSubprocessLaunchSpec(["--version"]);
			command = launch.command;
			args = launch.args;
		} else {
			const catalogEntry = resolveDaemonCatalogEntrypoint();
			const execArgs = [...process.execArgv];
			if (catalogEntry.endsWith(".ts")) {
				const loaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
				execArgs.push("--import", loaderUrl);
			}
			const launch = createCliSubprocessLaunchSpec([], undefined, execArgs, catalogEntry);
			command = launch.command;
			args = launch.args;
			environment = createCliSubprocessEnv(environment, catalogEntry, execArgs);
		}
		const child = spawnHidden(command, args, {
			cwd: process.cwd(),
			detached: process.platform !== "win32",
			env: environment,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			windowsHide: true,
		});
		this.child = child;
		this.childProcessStartIds.set(
			child,
			trackChildProcess(child, { unixDetachedSession: process.platform !== "win32" }),
		);
		child.on("message", (value: unknown) => this.handleMessage(value));
		child.on("error", (error) => this.handleClose(child, error));
		child.on("exit", (code, signal) =>
			this.handleClose(child, new Error(`Daemon catalog exited (${signal ?? code ?? "unknown"})`)),
		);
		await new Promise<void>((resolveReady, rejectReady) => {
			const timeout = setTimeout(() => {
				cleanup();
				const error = new Error("Timed out starting daemon catalog");
				this.handleClose(child, error);
				if (child.connected) {
					child.disconnect();
				}
				void this.terminateChild(child);
				rejectReady(error);
			}, DAEMON_CATALOG_START_TIMEOUT_MS);
			const cleanup = () => {
				clearTimeout(timeout);
				child.off("message", onMessage);
				child.off("error", onError);
				child.off("exit", onExit);
			};
			const onMessage = (value: unknown) => {
				if (isCatalogOutbound(value) && value.type === "ready") {
					cleanup();
					resolveReady();
				}
			};
			const onError = (error: Error) => {
				cleanup();
				rejectReady(error);
			};
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				onError(new Error(`Daemon catalog exited during startup (${signal ?? code ?? "unknown"})`));
			};
			child.on("message", onMessage);
			child.once("error", onError);
			child.once("exit", onExit);
		});
	}

	private async request<T = void>(
		request: CatalogRequest,
		callbacks?: CatalogListCallbacks,
		startIfNeeded = true,
		timeoutMs = 5 * 60 * 1000,
	): Promise<T> {
		if (startIfNeeded) await this.start();
		const child = this.child;
		if (!child?.connected) {
			throw new Error("Daemon catalog is not connected");
		}
		return new Promise<T>((resolveRequest, rejectRequest) => {
			const timeout = setTimeout(() => {
				if (!this.pending.delete(request.id)) {
					return;
				}
				void this.terminateChild(child);
				rejectRequest(new Error(`Timed out waiting for daemon catalog ${request.command}`));
			}, timeoutMs);
			this.pending.set(request.id, {
				resolve: (data) => resolveRequest(data as T),
				reject: rejectRequest,
				callbacks,
				timeout,
			});
			child.send(request, (error) => {
				if (!error) {
					return;
				}
				const pending = this.pending.get(request.id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pending.delete(request.id);
				}
				rejectRequest(error);
			});
		});
	}

	private handleMessage(value: unknown): void {
		if (!isCatalogOutbound(value) || value.type === "ready") {
			return;
		}
		const pending = this.pending.get(value.id);
		if (!pending) {
			return;
		}
		if (value.type === "progress") {
			pending.callbacks?.onProgress?.(value.loaded, value.total);
			return;
		}
		if (value.type === "session") {
			pending.callbacks?.onSession?.(deserializeSessionInfo(value.session));
			return;
		}
		this.pending.delete(value.id);
		clearTimeout(pending.timeout);
		if (value.success) {
			pending.resolve(value.data);
		} else {
			pending.reject(new Error(value.error));
		}
		this.scheduleIdleStop();
	}

	private handleClose(child: ChildProcess, error: Error): void {
		if (child.pid !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
			reconcileTrackedDetachedChildAfterExit(child.pid);
		}
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		this.clearIdleTimer();
		this.onDiagnostic(error.message);
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.pending.delete(id);
		}
	}

	private async terminateChild(child: ChildProcess): Promise<boolean> {
		const processStartId = this.childProcessStartIds.get(child);
		const complete =
			child.pid === undefined ? child.kill("SIGKILL") : await killProcessTreeByIdentity(child.pid, processStartId);
		if (child.pid !== undefined && complete) reconcileTrackedDetachedChildAfterExit(child.pid);
		return complete;
	}

	private scheduleIdleStop(): void {
		this.clearIdleTimer();
		if (!this.child?.connected || this.pending.size > 0) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.pending.size === 0) void this.stop();
		}, CATALOG_IDLE_TIMEOUT_MS);
		this.idleTimer.unref();
	}

	private clearIdleTimer(): void {
		if (!this.idleTimer) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}
}
