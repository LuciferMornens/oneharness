import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.js";
import { getProcessStartId } from "../../core/session-lease.js";
import { isProcessAlive } from "../../utils/child-process.js";
import { canonicalizeDaemonFilesystemPath, defaultDaemonSocketDir } from "./daemon-paths.js";
import {
	type DaemonSupervisorSocketCandidate,
	resolveWindowsDaemonSupervisorSocketCandidates,
	selectWindowsDaemonSupervisorSocketCandidate,
} from "./daemon-supervisor-ownership.js";

export { normalizeSocketPath } from "../../utils/daemon-socket-path.js";
export { canonicalizeDaemonFilesystemPath, defaultDaemonSocketDir } from "./daemon-paths.js";

const DAEMON_SOCKET_MODE = 0o600;
const DAEMON_SOCKET_DIR_MODE = 0o700;
const DAEMON_SOCKET_RELEASE_GRACE_MS = 1000;
const DAEMON_SOCKET_RELEASE_POLL_MS = 25;
const DAEMON_SOCKET_LOCK_STALE_MS = 5000;
const DAEMON_SOCKET_LOCK_UPDATE_MS = 1000;
const SUPERVISOR_CONFIG_FILE_NAME = "supervisor-config";
const WINDOWS_ORIGINAL_DEFAULT_DAEMON_SOCKET_PATH = "\\\\.\\pipe\\prime-agent-daemon";
const WINDOWS_DEFAULT_DAEMON_SOCKET_PATTERN = /^\\\\\.\\pipe\\prime-agent-daemon-[a-f0-9]{12}$/iu;

interface PersistedSupervisorConfig {
	version?: unknown;
	socketPath?: unknown;
	defaultSessionConfig?: {
		agentDir?: unknown;
	};
}

export class DaemonSocketPathLease {
	private released = false;

	constructor(
		readonly socketPath: string,
		private readonly releaseLock: () => Promise<void>,
	) {}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		this.released = true;
		await this.releaseLock();
	}
}

export interface DaemonSocketIdentity {
	dev: number;
	ino: number;
}

export function defaultDaemonSocketPath(): string {
	if (process.platform === "win32") {
		const agentDir = getAgentDir();
		const agentIdentity = canonicalizeDaemonFilesystemPath(agentDir);
		const canonicalSocketPath = windowsDefaultDaemonSocketPathForAgentDir(agentIdentity);
		return persistedWindowsDaemonSocketPath(agentDir) ?? canonicalSocketPath;
	}
	return join(defaultDaemonSocketDir(), "daemon.sock");
}

export function windowsDefaultDaemonSocketPathForAgentDir(agentDir: string): string {
	const agentIdentity = canonicalizeDaemonFilesystemPath(agentDir);
	const suffix = createHash("sha256").update(agentIdentity).digest("hex").slice(0, 12);
	return `\\\\.\\pipe\\prime-agent-daemon-${suffix}`;
}

export function isOriginalWindowsDefaultDaemonSocketPath(socketPath: string): boolean {
	return socketPath.toLowerCase() === WINDOWS_ORIGINAL_DEFAULT_DAEMON_SOCKET_PATH;
}

function persistedWindowsDaemonSocketPath(agentDir: string): string | undefined {
	return selectWindowsDaemonSupervisorSocketCandidate(agentDir, readWindowsDaemonSocketCandidates(agentDir, false));
}

export function listRecoverableWindowsDaemonSocketPaths(agentDir: string = getAgentDir()): string[] {
	if (process.platform !== "win32") {
		return [];
	}
	const resolution = resolveWindowsDaemonSupervisorSocketCandidates(
		agentDir,
		readWindowsDaemonSocketCandidates(agentDir, true),
	);
	return [
		...new Set(
			[
				windowsDefaultDaemonSocketPathForAgentDir(agentDir),
				...resolution.activeCandidates.map((candidate) => candidate.socketPath),
				...resolution.liveListenerCandidates.map((candidate) => candidate.socketPath),
				...resolution.residentCandidates.map((candidate) => candidate.socketPath),
			].map((socketPath) => socketPath.toLowerCase()),
		),
	];
}

function readWindowsDaemonSocketCandidates(
	agentDir: string,
	includeCustomSockets: boolean,
): DaemonSupervisorSocketCandidate[] {
	const descriptorRoot = join(agentDir, "daemon-workers");
	const canonicalAgentDir = canonicalizeDaemonFilesystemPath(agentDir);
	const canonicalDescriptorRoot = canonicalizeDaemonFilesystemPath(join(canonicalAgentDir, "daemon-workers"));
	let descriptorNames: string[];
	try {
		descriptorNames = readdirSync(descriptorRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const candidates: DaemonSupervisorSocketCandidate[] = [];
	for (const descriptorName of descriptorNames) {
		const descriptorDir = join(descriptorRoot, descriptorName);
		try {
			if (
				!lstatSync(descriptorDir).isDirectory() ||
				dirname(canonicalizeDaemonFilesystemPath(descriptorDir)) !== canonicalDescriptorRoot
			) {
				continue;
			}
			const config = JSON.parse(
				readFileSync(join(descriptorDir, SUPERVISOR_CONFIG_FILE_NAME), "utf8"),
			) as PersistedSupervisorConfig;
			if (
				config.version !== 1 ||
				typeof config.socketPath !== "string" ||
				(!includeCustomSockets &&
					config.socketPath.toLowerCase() !== WINDOWS_ORIGINAL_DEFAULT_DAEMON_SOCKET_PATH &&
					!WINDOWS_DEFAULT_DAEMON_SOCKET_PATTERN.test(config.socketPath)) ||
				(includeCustomSockets && !isWindowsNamedPipePath(config.socketPath)) ||
				typeof config.defaultSessionConfig?.agentDir !== "string" ||
				canonicalizeDaemonFilesystemPath(config.defaultSessionConfig.agentDir) !== canonicalAgentDir ||
				descriptorName !== daemonSocketDescriptorKey(config.socketPath)
			) {
				continue;
			}
			candidates.push({
				socketPath: config.socketPath,
				descriptorDir,
				hasLiveResidentWorkers: hasLiveResidentWorker(descriptorDir, config.socketPath),
				hasLiveListener: isWindowsNamedPipePresent(config.socketPath),
			});
		} catch {
			// Skip unreadable or corrupt supervisor descriptors during discovery.
		}
	}
	return candidates;
}

function isWindowsNamedPipePath(socketPath: string): boolean {
	return socketPath.toLowerCase().startsWith("\\\\.\\pipe\\") && socketPath.length > "\\\\.\\pipe\\".length;
}

function isWindowsNamedPipePresent(socketPath: string): boolean {
	try {
		lstatSync(socketPath);
		return true;
	} catch {
		return false;
	}
}

function hasLiveResidentWorker(descriptorDir: string, supervisorSocketPath: string): boolean {
	for (const name of readdirSync(descriptorDir)) {
		if (!name.endsWith(".json")) {
			continue;
		}
		try {
			const descriptor = JSON.parse(readFileSync(join(descriptorDir, name), "utf8")) as {
				pid?: unknown;
				processStartId?: unknown;
				socketPath?: unknown;
				authenticationToken?: unknown;
				supervisorSocketPath?: unknown;
			};
			if (
				!Number.isInteger(descriptor.pid) ||
				(descriptor.pid as number) <= 0 ||
				typeof descriptor.socketPath !== "string" ||
				!isWindowsNamedPipePath(descriptor.socketPath) ||
				typeof descriptor.authenticationToken !== "string" ||
				descriptor.authenticationToken.length === 0 ||
				typeof descriptor.supervisorSocketPath !== "string" ||
				descriptor.supervisorSocketPath.toLowerCase() !== supervisorSocketPath.toLowerCase()
			) {
				continue;
			}
			const observedProcessStartId = getProcessStartId(descriptor.pid as number);
			const originalDefaultPipe = supervisorSocketPath.toLowerCase() === WINDOWS_ORIGINAL_DEFAULT_DAEMON_SOCKET_PATH;
			// The original unscoped pipe is the one pre-upgrade location whose
			// durable descriptor must still be opened after its worker exited or
			// its pid was replaced. The successor then relaunches / cleans it.
			if (
				originalDefaultPipe &&
				(descriptor.processStartId === undefined ||
					!isProcessAlive(descriptor.pid as number) ||
					(typeof descriptor.processStartId === "string" &&
						observedProcessStartId !== undefined &&
						observedProcessStartId !== descriptor.processStartId))
			) {
				return true;
			}
			if (
				(typeof descriptor.processStartId === "string" && observedProcessStartId === descriptor.processStartId) ||
				(descriptor.processStartId === undefined &&
					observedProcessStartId !== undefined &&
					isWindowsNamedPipePresent(descriptor.socketPath))
			) {
				return true;
			}
		} catch {
			// Skip unreadable or corrupt worker descriptors when probing liveness.
		}
	}
	return false;
}

function daemonSocketDescriptorKey(socketPath: string): string {
	return createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
}

export async function acquireDaemonSocketPathLease(socketPath: string): Promise<DaemonSocketPathLease | undefined> {
	ensureDefaultDaemonSocketDir(socketPath);
	if (process.platform === "win32") {
		return undefined;
	}
	const releaseLock = await lockfile.lock(socketPath, {
		realpath: false,
		stale: DAEMON_SOCKET_LOCK_STALE_MS,
		update: DAEMON_SOCKET_LOCK_UPDATE_MS,
		retries: {
			retries: 600,
			factor: 1,
			minTimeout: DAEMON_SOCKET_RELEASE_POLL_MS,
			maxTimeout: DAEMON_SOCKET_RELEASE_POLL_MS,
		},
	});
	return new DaemonSocketPathLease(socketPath, releaseLock);
}

export async function prepareDaemonSocketPath(socketPath: string, lease?: DaemonSocketPathLease): Promise<void> {
	ensureDefaultDaemonSocketDir(socketPath);

	if (process.platform === "win32") {
		return;
	}
	if (lease) {
		assertSocketLease(socketPath, lease);
		await prepareUnixDaemonSocketPath(socketPath);
		return;
	}
	if (!existsSync(socketPath)) {
		return;
	}
	if (await canConnectToUnixSocket(socketPath)) {
		throw new Error(`Daemon socket already in use: ${socketPath}`);
	}
	const ownedLease = await acquireDaemonSocketPathLease(socketPath);
	try {
		await prepareUnixDaemonSocketPath(socketPath);
	} finally {
		await ownedLease?.release();
	}
}

async function prepareUnixDaemonSocketPath(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) {
		return;
	}

	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
	if (!stat.isSocket()) {
		throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
	}

	const staleIdentity: DaemonSocketIdentity = { dev: stat.dev, ino: stat.ino };
	if (await canConnectToUnixSocket(socketPath)) {
		throw new Error(`Daemon socket already in use: ${socketPath}`);
	}
	const deadline = Date.now() + DAEMON_SOCKET_RELEASE_GRACE_MS;
	while (Date.now() < deadline) {
		await delay(DAEMON_SOCKET_RELEASE_POLL_MS);
		if (!existsSync(socketPath)) {
			return;
		}
		let currentIdentity: DaemonSocketIdentity | undefined;
		try {
			currentIdentity = getDaemonSocketIdentity(socketPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		if (!currentIdentity || currentIdentity.dev !== staleIdentity.dev || currentIdentity.ino !== staleIdentity.ino) {
			throw new Error(`Daemon socket changed ownership while waiting for cleanup: ${socketPath}`);
		}
		if (await canConnectToUnixSocket(socketPath)) {
			throw new Error(`Daemon socket already in use: ${socketPath}`);
		}
	}

	unlinkSync(socketPath);
}

export function restrictDaemonSocketPath(socketPath: string): void {
	if (process.platform === "win32") {
		return;
	}
	chmodSync(socketPath, DAEMON_SOCKET_MODE);
}

export function getDaemonSocketIdentity(socketPath: string): DaemonSocketIdentity | undefined {
	if (process.platform === "win32") {
		return undefined;
	}
	const stat = lstatSync(socketPath);
	return { dev: stat.dev, ino: stat.ino };
}

export function cleanupDaemonSocketPath(
	socketPath: string,
	expectedIdentity?: DaemonSocketIdentity,
	lease?: DaemonSocketPathLease,
): void {
	if (process.platform === "win32") {
		return;
	}
	if (lease) {
		assertSocketLease(socketPath, lease);
		try {
			cleanupUnixDaemonSocketPath(socketPath, expectedIdentity);
		} catch {
			// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
		}
		return;
	}
	let releaseLock: (() => void) | undefined;
	try {
		releaseLock = lockfile.lockSync(socketPath, {
			realpath: false,
			stale: DAEMON_SOCKET_LOCK_STALE_MS,
			update: DAEMON_SOCKET_LOCK_UPDATE_MS,
			retries: 0,
		});
	} catch {
		return;
	}
	try {
		cleanupUnixDaemonSocketPath(socketPath, expectedIdentity);
	} catch {
		// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
	} finally {
		try {
			releaseLock();
		} catch {
			// Best effort cleanup; a failed release is recoverable as a stale lock.
		}
	}
}

function cleanupUnixDaemonSocketPath(socketPath: string, expectedIdentity?: DaemonSocketIdentity): void {
	if (!existsSync(socketPath)) {
		return;
	}
	if (expectedIdentity) {
		const currentIdentity = getDaemonSocketIdentity(socketPath);
		if (
			!currentIdentity ||
			currentIdentity.dev !== expectedIdentity.dev ||
			currentIdentity.ino !== expectedIdentity.ino
		) {
			return;
		}
	}
	unlinkSync(socketPath);
}

function assertSocketLease(socketPath: string, lease: DaemonSocketPathLease): void {
	if (lease.socketPath !== socketPath) {
		throw new Error(`Daemon socket lease does not match ${socketPath}`);
	}
}

function ensureDefaultDaemonSocketDir(socketPath: string): void {
	if (process.platform === "win32" || dirname(socketPath) !== defaultDaemonSocketDir()) {
		return;
	}

	if (!existsSync(defaultDaemonSocketDir())) {
		mkdirSync(defaultDaemonSocketDir(), { recursive: true, mode: DAEMON_SOCKET_DIR_MODE });
	}

	const stat = lstatSync(defaultDaemonSocketDir());
	if (!stat.isDirectory()) {
		throw new Error(`Daemon socket directory exists and is not a directory: ${defaultDaemonSocketDir()}`);
	}

	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`Daemon socket directory is not owned by the current user: ${defaultDaemonSocketDir()}`);
	}

	chmodSync(defaultDaemonSocketDir(), DAEMON_SOCKET_DIR_MODE);
}

function canConnectToUnixSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (canConnect: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(canConnect);
		};

		timeoutId = setTimeout(() => finish(false), 250);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
