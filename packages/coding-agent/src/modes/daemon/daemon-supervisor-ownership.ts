import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { APP_NAME } from "../../config.js";
import { getProcessStartId } from "../../core/session-lease.js";
import { writeFileAtomicSync } from "../../utils/atomic-file.js";
import { isZombieProcess, processIdExists } from "../../utils/child-process.js";
import { normalizeSocketPath } from "../../utils/daemon-socket-path.js";
import { canonicalizeDaemonFilesystemPath, defaultDaemonSocketDir } from "./daemon-paths.js";

export const DAEMON_SUPERVISOR_REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
export const DAEMON_SUPERVISOR_SELECTED_REGISTRY_DIR_ENV =
	"PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SELECTED_REGISTRY_DIR";

const OWNER_VERSION = 1;
const REGISTRY_LOCK_STALE_MS = 5000;
const REGISTRY_LOCK_UPDATE_MS = 1000;
const REGISTRY_LOCK_RETRIES = 500;
const REGISTRY_LOCK_RETRY_MS = 10;
const STARTUP_FENCE_POLL_MS = 250;
const SHUTDOWN_ADMISSION_FILE_NAME = "shutdown-admission.json";
const SHUTDOWN_ADMISSION_LEASE_MS = 5000;
const SHUTDOWN_ADMISSION_REFRESH_MS = 1000;
const SHUTDOWN_ADMISSION_WAIT_MS = 50;
const KNOWN_AGENT_DIRS_FILE_NAME = "known-agent-dirs.json";
const MAX_KNOWN_AGENT_DIRS = 128;
const LEGACY_OWNER_STARTUP_GRACE_MS = 5000;

type DaemonSupervisorOwnerPhase = "starting" | "owner" | "stopping";

interface ProcessIdentity {
	pid: number;
	processStartId?: string;
}

export interface DaemonSupervisorProcess extends ProcessIdentity {
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
	registryDir: string;
}

export interface DaemonSupervisorSocketCandidate {
	socketPath: string;
	descriptorDir: string;
	hasLiveResidentWorkers: boolean;
	hasLiveListener: boolean;
}

export interface WindowsDaemonSupervisorSocketResolution {
	activeCandidates: readonly DaemonSupervisorSocketCandidate[];
	liveListenerCandidates: readonly DaemonSupervisorSocketCandidate[];
	residentCandidates: readonly DaemonSupervisorSocketCandidate[];
	hasDuplicateActiveOwners: boolean;
}

export class AmbiguousWindowsDaemonSocketError extends Error {
	constructor(readonly socketPaths: readonly string[]) {
		super(`Multiple live daemon candidates match the same agent directory: ${socketPaths.join(", ")}`);
		this.name = "AmbiguousWindowsDaemonSocketError";
	}
}

interface DaemonSupervisorOwnerRecord extends ProcessIdentity {
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	socketPath: string;
	processStartId: string;
	descriptorDir: string;
	agentDir: string;
	appVersion: string;
	phase: DaemonSupervisorOwnerPhase;
	createdAt: string;
	updatedAt: string;
}

interface DaemonShutdownAdmissionRecord extends ProcessIdentity {
	version: 1;
	token: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

interface DaemonSupervisorOwnerScope {
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
}

interface PersistedDaemonSupervisorOwnerRecord {
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	pid: number;
	processStartId?: string;
	socketPath: string;
	descriptorDir: string;
	agentDir?: string;
	appVersion: string;
	phase: DaemonSupervisorOwnerPhase;
	createdAt: string;
	updatedAt: string;
}

interface PersistedDaemonSupervisorOwnerScope {
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	socketPath: string;
	descriptorDir: string;
	agentDir?: string;
}

interface KnownDaemonAgentDirEntry {
	agentDir: string;
	descriptorRoot: string;
	registryDir?: string;
	updatedAt: string;
}

interface KnownDaemonAgentDirsRecord {
	version: 1;
	entries: KnownDaemonAgentDirEntry[];
}

interface DaemonStartupFenceRecord extends ProcessIdentity {
	version: 1;
	token: string;
	ownerToken: string;
	socketPath: string;
	supervisorGeneration: string;
	createdAt: string;
}

interface DaemonSupervisorHelloIdentity {
	supervisorGeneration?: string;
	supervisorOwnerToken?: string;
	supervisorPid?: number;
	supervisorProcessStartId?: string;
	supervisorSocketPath?: string;
}

interface AcquireDaemonSupervisorOwnershipOptions {
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
	generation: string;
	appVersion: string;
	registryDir?: string;
	preserveLegacyWindowsWorkerOwnership?: boolean;
}

interface DaemonSupervisorOwnershipRegistration {
	registryDir: string;
	ownerDirectory: string;
}

interface UnixRegistryPathIdentity {
	path: string;
	device: number;
	inode: number;
}

class DaemonSupervisorAlreadyRunningError extends Error {
	readonly code = "daemon_supervisor_already_running" as const;

	constructor(readonly owner: DaemonSupervisorOwnerRecord) {
		super(`Daemon supervisor ${owner.generation} already owns ${owner.socketPath}`);
		this.name = "DaemonSupervisorAlreadyRunningError";
	}
}

class DaemonSupervisorOwnershipLostError extends Error {
	readonly code = "supervisor_generation_stale" as const;

	constructor(generation: string, details: { socketPath?: string; registryDir?: string } = {}) {
		const context = [
			details.socketPath ? `socket: ${details.socketPath}` : undefined,
			details.registryDir ? `registry: ${details.registryDir}` : undefined,
		].filter((part) => part !== undefined);
		super(
			`Daemon supervisor generation ${generation} no longer owns its registry entry ` +
				`(record on disk is missing or was replaced)${context.length > 0 ? `; ${context.join("; ")}` : ""}; ` +
				"restart the daemon to recover — sessions are preserved",
		);
		this.name = "DaemonSupervisorOwnershipLostError";
	}
}

class DaemonShutdownAdmissionError extends Error {
	readonly code = "daemon_shutdown_in_progress" as const;

	constructor(message = "Daemon shutdown is in progress") {
		super(message);
		this.name = "DaemonShutdownAdmissionError";
	}
}

class DaemonSupervisorOwnership {
	private released = false;

	constructor(
		readonly record: DaemonSupervisorOwnerRecord,
		readonly registryDir: string,
		private readonly registrations: readonly DaemonSupervisorOwnershipRegistration[],
	) {}

	async assertCurrent(): Promise<void> {
		if (this.released) {
			throw this.ownershipLostError();
		}
		// The durable registration is authoritative; Temp compatibility metadata may disappear while this owner is live.
		const current =
			process.platform === "win32"
				? readOwnerRecord(ownerDirectoryPath(this.registryDir, this.record.generation))
				: await withDaemonSupervisorRegistryGuard(this.registryDir, () =>
						readOwnerRecord(ownerDirectoryPath(this.registryDir, this.record.generation)),
					);
		if (!current || !sameOwnerRecord(current, this.record)) {
			throw this.ownershipLostError();
		}
	}

	private ownershipLostError(): DaemonSupervisorOwnershipLostError {
		return new DaemonSupervisorOwnershipLostError(this.record.generation, {
			socketPath: this.record.socketPath,
			registryDir: this.registryDir,
		});
	}

	async updatePhase(phase: DaemonSupervisorOwnerPhase): Promise<void> {
		if (this.released) {
			return;
		}
		await withDaemonSupervisorRegistryGuards(
			this.registrations.map((registration) => registration.registryDir),
			() => {
				const primaryDirectory = ownerDirectoryPath(this.registryDir, this.record.generation);
				const primary = readOwnerRecord(primaryDirectory);
				if (!primary || primary.token !== this.record.token) {
					throw new Error(`Daemon supervisor ownership was lost for ${this.record.socketPath}`);
				}
				const updatedAt = new Date().toISOString();
				for (const registration of this.registrations) {
					const current = readOwnerRecord(registration.ownerDirectory);
					if (!current || current.token !== this.record.token) {
						if (registration.registryDir === this.registryDir) {
							throw new Error(`Daemon supervisor ownership was lost for ${this.record.socketPath}`);
						}
						continue;
					}
					current.phase = phase;
					current.updatedAt = updatedAt;
					if (!isDaemonSupervisorOwnerRecord(current)) {
						throw new Error(`Invalid mutation for daemon supervisor owner ${this.record.generation}`);
					}
					writeOwnerRecord(registration.ownerDirectory, current);
				}
				this.record.phase = phase;
				this.record.updatedAt = updatedAt;
			},
		);
	}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		const releasedDirectories: string[] = [];
		try {
			await withDaemonSupervisorRegistryGuards(
				this.registrations.map((registration) => registration.registryDir),
				() => {
					for (const registration of this.registrations) {
						const current = readOwnerRecord(registration.ownerDirectory);
						if (!current || current.token !== this.record.token) {
							continue;
						}
						const releasedDirectory = `${registration.ownerDirectory}.released-${randomUUID()}`;
						renameSync(registration.ownerDirectory, releasedDirectory);
						releasedDirectories.push(releasedDirectory);
					}
				},
			);
			this.released = true;
		} finally {
			for (const releasedDirectory of releasedDirectories) {
				rmSync(releasedDirectory, { recursive: true, force: true });
			}
		}
	}
}

class DaemonShutdownAdmission {
	private released = false;
	private lost = false;
	private refreshPromise?: Promise<void>;
	private readonly refreshTimer: ReturnType<typeof setInterval>;

	constructor(
		private readonly record: DaemonShutdownAdmissionRecord,
		private registryDirs: string[],
	) {
		this.refreshTimer = setInterval(() => {
			void this.assertOrRenew().catch(() => undefined);
		}, SHUTDOWN_ADMISSION_REFRESH_MS);
		this.refreshTimer.unref();
	}

	async extendRegistryDirs(requestedRegistryDirs: readonly string[]): Promise<void> {
		if (this.released || this.lost) {
			throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
		}
		const registryDirs = uniqueRegistryDirs([...this.registryDirs, ...requestedRegistryDirs]);
		if (registryDirs.length === this.registryDirs.length) {
			await this.assertOrRenew();
			return;
		}
		try {
			await withDaemonSupervisorRegistryGuards(registryDirs, () => {
				if (!matchesExactProcessIdentity(this.record)) {
					throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
				}
				for (const registryDir of this.registryDirs) {
					const current = readShutdownAdmission(shutdownAdmissionPath(registryDir));
					if (!sameShutdownAdmission(current, this.record)) {
						throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
					}
				}
				const addedRegistryDirs = registryDirs.filter(
					(registryDir) =>
						!this.registryDirs.some(
							(currentRegistryDir) =>
								canonicalizeDaemonFilesystemPath(currentRegistryDir) ===
								canonicalizeDaemonFilesystemPath(registryDir),
						),
				);
				for (const registryDir of addedRegistryDirs) {
					const current = readActiveShutdownAdmission(registryDir);
					if (current && !sameShutdownAdmission(current, this.record)) {
						throw new DaemonShutdownAdmissionError();
					}
				}
				const now = Date.now();
				this.record.updatedAt = new Date(now).toISOString();
				this.record.expiresAt = new Date(now + SHUTDOWN_ADMISSION_LEASE_MS).toISOString();
				const acquiredRegistryDirs: string[] = [];
				try {
					for (const registryDir of addedRegistryDirs) {
						const path = shutdownAdmissionPath(registryDir);
						if (!readShutdownAdmission(path)) {
							writeJsonAtomically(path, this.record);
						}
						acquiredRegistryDirs.push(registryDir);
					}
					for (const registryDir of this.registryDirs) {
						writeJsonAtomically(shutdownAdmissionPath(registryDir), this.record);
					}
				} catch (error) {
					for (const registryDir of acquiredRegistryDirs) {
						const path = shutdownAdmissionPath(registryDir);
						if (sameShutdownAdmission(readShutdownAdmission(path), this.record)) {
							rmSync(path, { force: true });
						}
					}
					throw error;
				}
			});
			this.registryDirs = registryDirs;
		} catch (error) {
			this.lost = true;
			clearInterval(this.refreshTimer);
			throw error;
		}
	}

	async assertOrRenew(): Promise<void> {
		if (this.released || this.lost) {
			throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
		}
		this.refreshPromise ??= this.performRenew().finally(() => {
			this.refreshPromise = undefined;
		});
		await this.refreshPromise;
	}

	private async performRenew(): Promise<void> {
		try {
			await withDaemonSupervisorRegistryGuards(this.registryDirs, () => {
				// release() may have completed while this call waited on the guard;
				// a released record must never be rewritten to disk.
				if (this.released || this.lost) {
					throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
				}
				const primary = readShutdownAdmission(shutdownAdmissionPath(this.registryDirs[0]!));
				if (!sameShutdownAdmission(primary, this.record) || !matchesExactProcessIdentity(this.record)) {
					throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
				}
				const now = Date.now();
				this.record.updatedAt = new Date(now).toISOString();
				this.record.expiresAt = new Date(now + SHUTDOWN_ADMISSION_LEASE_MS).toISOString();
				for (const registryDir of this.registryDirs) {
					const current = readShutdownAdmission(shutdownAdmissionPath(registryDir));
					if (current && !sameShutdownAdmission(current, primary)) {
						throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
					}
					writeJsonAtomically(shutdownAdmissionPath(registryDir), this.record);
				}
			});
		} catch (error) {
			this.lost = true;
			clearInterval(this.refreshTimer);
			throw error;
		}
	}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		this.released = true;
		clearInterval(this.refreshTimer);
		await this.refreshPromise?.catch(() => undefined);
		await withDaemonSupervisorRegistryGuards(this.registryDirs, () => {
			for (const registryDir of this.registryDirs) {
				const path = shutdownAdmissionPath(registryDir);
				const current = readShutdownAdmission(path);
				if (current?.token === this.record.token) {
					rmSync(path, { force: true });
				}
			}
		});
	}
}

export function resolveDaemonSupervisorRegistryDir(environment: NodeJS.ProcessEnv = process.env): string {
	return (
		environment[DAEMON_SUPERVISOR_SELECTED_REGISTRY_DIR_ENV] ??
		environment[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV] ??
		platformDefaultDaemonSupervisorRegistryDir(environment)
	);
}

function defaultDaemonSupervisorRegistryDir(environment: NodeJS.ProcessEnv = process.env): string {
	return resolveDaemonSupervisorRegistryDir(environment);
}

function platformDefaultDaemonSupervisorRegistryDir(environment: NodeJS.ProcessEnv = process.env): string {
	return process.platform === "win32"
		? durableWindowsDaemonSupervisorRegistryDir(environment)
		: join(homedir(), ".prime", "supervisor-owners");
}

function durableWindowsDaemonSupervisorRegistryDir(environment: NodeJS.ProcessEnv = process.env): string {
	return resolve(
		environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
		APP_NAME,
		"daemon-supervisor-owners",
	);
}

function durableDaemonSupervisorDiscoveryRegistryDir(environment: NodeJS.ProcessEnv = process.env): string {
	if (process.platform === "win32") {
		return durableWindowsDaemonSupervisorRegistryDir(environment);
	}
	const stateRoot =
		environment.XDG_STATE_HOME && isAbsolute(environment.XDG_STATE_HOME)
			? environment.XDG_STATE_HOME
			: join(homedir(), ".local", "state");
	return resolve(stateRoot, APP_NAME, "daemon-supervisor-discovery");
}

function legacyWindowsDaemonSupervisorRegistryDir(): string {
	return resolve(defaultDaemonSocketDir(), "supervisor-owners");
}

/** Read-only legacy registry location, disabled when the registry is overridden. */
/**
 * Pre-move registry location under $TMPDIR, consulted READ-ONLY while daemons
 * from before the ~/.prime move may still be running. Gated off whenever the
 * registry is overridden. Windows already used a durable LOCALAPPDATA path;
 * its temp location stays the Windows-only legacy helper above.
 */
function implicitLegacyDaemonSupervisorRegistryDir(environment: NodeJS.ProcessEnv = process.env): string | undefined {
	if (environment[DAEMON_SUPERVISOR_SELECTED_REGISTRY_DIR_ENV] || environment[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV]) {
		return undefined;
	}
	return process.platform === "win32"
		? legacyWindowsDaemonSupervisorRegistryDir()
		: resolve(defaultDaemonSocketDir(), "supervisor-owners");
}

/**
 * Non-mutating legacy scan: never reclaims abandoned directories (old-build
 * daemons own that location's lifecycle) and runs without the legacy guard.
 */
function readLegacyOwnersForSocket(
	legacyRegistryDir: string,
	normalizedSocketPath: string,
): DaemonSupervisorOwnerRecord[] {
	let entries: string[];
	try {
		entries = readdirSync(legacyRegistryDir);
	} catch {
		return [];
	}
	return entries
		.filter((name) => name.endsWith(".owner"))
		.flatMap((name) => {
			const owner = readOwnerRecord(resolve(legacyRegistryDir, name));
			return owner && owner.socketPath === normalizedSocketPath ? [owner] : [];
		});
}

export function resolveWindowsDaemonSupervisorSocketCandidates(
	agentDir: string,
	candidates: readonly DaemonSupervisorSocketCandidate[],
): WindowsDaemonSupervisorSocketResolution {
	const canonicalAgentDir = canonicalizeDaemonFilesystemPath(agentDir);
	const distinctCandidates = [
		...new Map(
			candidates
				.filter(
					(candidate) =>
						dirname(canonicalizeDaemonFilesystemPath(candidate.descriptorDir)) ===
						canonicalizeDaemonFilesystemPath(resolve(canonicalAgentDir, "daemon-workers")),
				)
				.map((candidate) => [
					`${normalizeSocketPath(candidate.socketPath)}\0${canonicalizeDaemonFilesystemPath(candidate.descriptorDir)}`,
					candidate,
				]),
		).values(),
	];
	const candidateByOwnerIdentity = new Map(
		distinctCandidates.map((candidate) => [
			`${normalizeSocketPath(candidate.socketPath)}\0${canonicalizeDaemonFilesystemPath(candidate.descriptorDir)}`,
			candidate,
		]),
	);
	const registryDirs = uniqueRegistryDirs([
		...(process.env[DAEMON_SUPERVISOR_SELECTED_REGISTRY_DIR_ENV]
			? [process.env[DAEMON_SUPERVISOR_SELECTED_REGISTRY_DIR_ENV]]
			: []),
		...(process.env[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV] ? [process.env[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV]] : []),
		durableWindowsDaemonSupervisorRegistryDir(),
		legacyWindowsDaemonSupervisorRegistryDir(),
	]);
	const activeCandidates = new Map<string, DaemonSupervisorSocketCandidate>();
	const activeOwnerKeysByCandidate = new Map<string, Set<string>>();
	const seenOwners = new Set<string>();
	for (const registryDir of registryDirs) {
		if (!existsSync(registryDir)) {
			continue;
		}
		let ownerDirectories: string[];
		try {
			ownerDirectories = listOwnerDirectories(registryDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				continue;
			}
			throw error;
		}
		for (const ownerDirectory of ownerDirectories) {
			const owner = readOwnerRecord(ownerDirectory);
			if (
				!owner ||
				owner.agentDir !== canonicalAgentDir ||
				!matchesExactProcessIdentity(owner) ||
				(owner.phase === "owner" && !isWindowsNamedPipePresent(owner.socketPath))
			) {
				continue;
			}
			const ownerKey = `${owner.generation}\0${owner.pid}\0${owner.processStartId}\0${owner.socketPath}\0${owner.descriptorDir}`;
			if (seenOwners.has(ownerKey)) {
				continue;
			}
			seenOwners.add(ownerKey);
			const candidateKey = `${owner.socketPath}\0${owner.descriptorDir}`;
			const candidate = candidateByOwnerIdentity.get(candidateKey);
			if (candidate) {
				activeCandidates.set(candidateKey, candidate);
				const ownerKeys = activeOwnerKeysByCandidate.get(candidateKey) ?? new Set<string>();
				ownerKeys.add(ownerKey);
				activeOwnerKeysByCandidate.set(candidateKey, ownerKeys);
			}
		}
	}
	const residentCandidates = distinctCandidates.filter((candidate) => candidate.hasLiveResidentWorkers);
	const liveListenerCandidates = distinctCandidates.filter((candidate) => candidate.hasLiveListener);
	return {
		activeCandidates: [...activeCandidates.values()],
		liveListenerCandidates,
		residentCandidates,
		hasDuplicateActiveOwners: [...activeOwnerKeysByCandidate.values()].some((ownerKeys) => ownerKeys.size > 1),
	};
}

export function selectWindowsDaemonSupervisorSocketCandidate(
	agentDir: string,
	candidates: readonly DaemonSupervisorSocketCandidate[],
): string | undefined {
	const resolution = resolveWindowsDaemonSupervisorSocketCandidates(agentDir, candidates);
	if (resolution.activeCandidates.length > 1 || resolution.hasDuplicateActiveOwners) {
		throw new AmbiguousWindowsDaemonSocketError(resolution.activeCandidates.map((candidate) => candidate.socketPath));
	}
	const activeCandidate = resolution.activeCandidates[0];
	if (activeCandidate) {
		return activeCandidate.socketPath;
	}
	if (resolution.liveListenerCandidates.length > 1) {
		throw new AmbiguousWindowsDaemonSocketError(
			resolution.liveListenerCandidates.map((candidate) => candidate.socketPath),
		);
	}
	const liveListenerCandidate = resolution.liveListenerCandidates[0];
	if (liveListenerCandidate) {
		return liveListenerCandidate.socketPath;
	}
	if (resolution.residentCandidates.length > 1) {
		throw new AmbiguousWindowsDaemonSocketError(
			resolution.residentCandidates.map((candidate) => candidate.socketPath),
		);
	}
	return resolution.residentCandidates[0]?.socketPath;
}

function isWindowsNamedPipePresent(socketPath: string): boolean {
	try {
		statSync(socketPath);
		return true;
	} catch {
		return false;
	}
}

async function withDaemonSupervisorRegistryGuard<T>(registryDir: string, action: () => T | Promise<T>): Promise<T> {
	const initialIdentity = ensureSecureDaemonSupervisorRegistryDir(registryDir, true);
	const guardPath = resolve(registryDir, ".guard");
	let compromisedError: Error | undefined;
	const release = await lockfile.lock(registryDir, {
		realpath: false,
		lockfilePath: guardPath,
		stale: REGISTRY_LOCK_STALE_MS,
		update: REGISTRY_LOCK_UPDATE_MS,
		onCompromised: (error) => {
			compromisedError ??= error;
		},
		retries: {
			retries: REGISTRY_LOCK_RETRIES,
			factor: 1,
			minTimeout: REGISTRY_LOCK_RETRY_MS,
			maxTimeout: REGISTRY_LOCK_RETRY_MS,
		},
	});
	// Compromise detection is timer-driven and cannot preempt a synchronous stall: a stalled action's
	// writes may already be on disk when a successor reclaims the stale guard. The guard directory's
	// inode is the ownership identity (a steal is rmdir+mkdir), checked synchronously where the timer
	// cannot run; when the inode is unobservable, only timer-driven detection applies.
	const guardIno = (() => {
		try {
			return statSync(guardPath, { bigint: true }).ino;
		} catch {
			return undefined;
		}
	})();
	const guardStolen = () => {
		if (guardIno === undefined) return false;
		try {
			return statSync(guardPath, { bigint: true }).ino !== guardIno;
		} catch {
			return true;
		}
	};
	const assertGuardHeld = () => {
		if (compromisedError)
			throw new Error(`Daemon supervisor registry guard was compromised: ${compromisedError.message}`);
		if (guardStolen())
			throw new Error("Daemon supervisor registry guard was compromised: the guard lock changed hands");
	};
	try {
		const lockedIdentity = ensureSecureDaemonSupervisorRegistryDir(registryDir, false);
		assertSameUnixRegistryPathIdentity(registryDir, initialIdentity, lockedIdentity);
		assertGuardHeld();
		const result = await action();
		assertGuardHeld();
		assertSameUnixRegistryPathIdentity(
			registryDir,
			lockedIdentity,
			ensureSecureDaemonSupervisorRegistryDir(registryDir, false),
		);
		return result;
	} finally {
		if (compromisedError) {
			await release().catch(() => undefined);
		} else if (!guardStolen()) {
			await release();
		}
		// A stolen-but-undetected guard is never released: that would delete the successor's lock.
		// The abandoned updater notices the foreign mtime on its next tick and cleans itself up.
	}
}

function mkdirPrivateDaemonSupervisorDir(directory: string, recursive = false): void {
	mkdirSync(directory, { recursive, mode: 0o700 });
	chmodSync(directory, 0o700);
}

function ensureSecureDaemonSupervisorRegistryDir(
	registryDir: string,
	create: boolean,
): UnixRegistryPathIdentity[] | undefined {
	if (existsSync(registryDir)) {
		const existing = lstatSync(registryDir);
		if (existing.isSymbolicLink() || !existing.isDirectory()) {
			throw new Error(`Insecure daemon supervisor registry path: ${registryDir}`);
		}
	}
	if (process.platform === "win32") {
		if (create) {
			mkdirPrivateDaemonSupervisorDir(registryDir, true);
		}
		return undefined;
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid === undefined) {
		throw new Error(`Cannot verify daemon supervisor registry ownership: ${registryDir}`);
	}
	const resolvedRegistryDir = resolveUnixRegistryPathForValidation(registryDir, uid);
	const root = parse(resolvedRegistryDir).root;
	const suffix = resolvedRegistryDir.slice(root.length).split(/[\\/]/u).filter(Boolean);
	const directories = [root];
	for (const component of suffix) {
		directories.push(resolve(directories.at(-1)!, component));
	}
	const identities: UnixRegistryPathIdentity[] = [];
	let belowSharedBoundary = false;
	for (const directory of directories) {
		try {
			const metadata = lstatSync(directory);
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
				throw new Error(`Insecure daemon supervisor registry path: ${directory}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create || directory === root) {
				throw error;
			}
			mkdirPrivateDaemonSupervisorDir(directory);
		}
		const metadata = lstatSync(directory);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw new Error(`Insecure daemon supervisor registry path: ${directory}`);
		}
		const isRootOwnedStickyBoundary =
			metadata.uid === 0 && (metadata.mode & 0o1000) !== 0 && (metadata.mode & 0o022) !== 0;
		if (metadata.uid !== uid && metadata.uid !== 0) {
			throw new Error(`Insecure daemon supervisor registry owner: ${directory}`);
		}
		if ((metadata.mode & 0o022) !== 0 && !isRootOwnedStickyBoundary) {
			throw new Error(`Insecure daemon supervisor registry permissions: ${directory}`);
		}
		if (belowSharedBoundary && (metadata.uid !== uid || (metadata.mode & 0o077) !== 0)) {
			throw new Error(`Insecure daemon supervisor registry directory: ${directory}`);
		}
		if (isRootOwnedStickyBoundary) {
			belowSharedBoundary = true;
		}
		identities.push({ path: directory, device: metadata.dev, inode: metadata.ino });
	}
	const registryMetadata = lstatSync(resolvedRegistryDir);
	if (registryMetadata.uid !== uid || (registryMetadata.mode & 0o077) !== 0) {
		throw new Error(`Insecure daemon supervisor registry directory: ${resolvedRegistryDir}`);
	}
	return identities;
}

function resolveUnixRegistryPathForValidation(registryDir: string, uid: number): string {
	const resolvedRegistryDir = resolve(registryDir);
	const trustedTempBoundary = resolve(tmpdir());
	const relativeToTemp = relative(trustedTempBoundary, resolvedRegistryDir);
	const isWithinTrustedTemp =
		relativeToTemp === "" ||
		(!relativeToTemp.startsWith(`..${sep}`) && relativeToTemp !== ".." && !isAbsolute(relativeToTemp));
	if (!isWithinTrustedTemp) {
		// Resolve symlinked ancestors (e.g. /var on macOS) so the security walk below
		// validates the physical chain; the temp branch gets the same via realpath.
		return canonicalizeDaemonFilesystemPath(resolvedRegistryDir);
	}
	const tempRoot = parse(trustedTempBoundary).root;
	const tempSuffix = trustedTempBoundary.slice(tempRoot.length).split(/[\\/]/u).filter(Boolean);
	let tempComponent = tempRoot;
	for (const component of tempSuffix) {
		tempComponent = resolve(tempComponent, component);
		const metadata = lstatSync(tempComponent);
		if (metadata.isSymbolicLink() && metadata.uid !== 0) {
			throw new Error(`Insecure daemon supervisor temp boundary: ${tempComponent}`);
		}
		if (!metadata.isSymbolicLink() && !metadata.isDirectory()) {
			throw new Error(`Insecure daemon supervisor temp boundary: ${tempComponent}`);
		}
		if (!metadata.isSymbolicLink() && metadata.uid !== uid && metadata.uid !== 0) {
			throw new Error(`Insecure daemon supervisor temp boundary owner: ${tempComponent}`);
		}
	}
	const physicalTempBoundary = realpathSync.native(trustedTempBoundary);
	return resolve(physicalTempBoundary, relativeToTemp);
}

function assertSameUnixRegistryPathIdentity(
	registryDir: string,
	left: readonly UnixRegistryPathIdentity[] | undefined,
	right: readonly UnixRegistryPathIdentity[] | undefined,
): void {
	if (process.platform === "win32") return;
	if (
		!left ||
		!right ||
		left.length !== right.length ||
		left.some(
			(entry, index) =>
				entry.path !== right[index]?.path ||
				entry.device !== right[index]?.device ||
				entry.inode !== right[index]?.inode,
		)
	) {
		throw new Error(`Insecure daemon supervisor registry path changed: ${registryDir}`);
	}
}

async function withDaemonSupervisorRegistryGuards<T>(
	registryDirs: readonly string[],
	action: () => T | Promise<T>,
): Promise<T> {
	const distinctRegistryDirs = [
		...new Map(
			registryDirs.map((registryDir) => [canonicalizeDaemonFilesystemPath(registryDir), registryDir]),
		).entries(),
	]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, registryDir]) => registryDir);
	const run = (index: number): Promise<T> => {
		const registryDir = distinctRegistryDirs[index];
		if (!registryDir) {
			return Promise.resolve(action());
		}
		return withDaemonSupervisorRegistryGuard(registryDir, () => run(index + 1));
	};
	return run(0);
}

export async function acquireDaemonSupervisorOwnership(
	options: AcquireDaemonSupervisorOwnershipOptions,
): Promise<DaemonSupervisorOwnership> {
	const registryDir = options.registryDir ?? defaultDaemonSupervisorRegistryDir();
	// Pre-migration workers retain the legacy registry path in memory, so a successor must publish there while
	// keeping the durable registry authoritative. Both registries are always checked to fence old supervisors.
	const legacyRegistryDir = usesDurableWindowsDaemonSupervisorRegistry(registryDir)
		? legacyWindowsDaemonSupervisorRegistryDir()
		: undefined;
	const conflictRegistryDirs = uniqueRegistryDirs(
		legacyRegistryDir ? [registryDir, legacyRegistryDir] : [registryDir],
	);
	const selectedRegistryEnvironment =
		process.env[DAEMON_SUPERVISOR_SELECTED_REGISTRY_DIR_ENV] ?? process.env[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV];
	const publishDurableDiscovery =
		options.registryDir === undefined ||
		(selectedRegistryEnvironment !== undefined &&
			canonicalizeDaemonFilesystemPath(selectedRegistryEnvironment) ===
				canonicalizeDaemonFilesystemPath(registryDir));
	const discoveryRegistryDirs = publishDurableDiscovery
		? uniqueRegistryDirs([durableDaemonSupervisorDiscoveryRegistryDir()])
		: [];
	// The durable discovery registry is also the global admission fence. It must
	// participate in every acquisition, including the first supervisor to use a
	// previously unknown custom registry, so shutdown can fence future registries.
	const admissionRegistryDirs = uniqueRegistryDirs([
		...conflictRegistryDirs,
		durableDaemonSupervisorDiscoveryRegistryDir(),
	]);
	const token = randomUUID();
	const processStartId = getProcessStartId(process.pid);
	if (!processStartId) {
		throw new Error("Cannot acquire daemon supervisor ownership without an exact process-start identity");
	}
	const now = new Date().toISOString();
	const record: DaemonSupervisorOwnerRecord = {
		version: OWNER_VERSION,
		role: "supervisor",
		token,
		generation: options.generation,
		pid: process.pid,
		processStartId,
		socketPath: normalizeSocketPath(options.socketPath),
		descriptorDir: canonicalizeDaemonFilesystemPath(options.descriptorDir),
		agentDir: canonicalizeDaemonFilesystemPath(options.agentDir),
		appVersion: options.appVersion,
		phase: "starting",
		createdAt: now,
		updatedAt: now,
	};
	const ownershipRegistryDirs = uniqueRegistryDirs(
		options.preserveLegacyWindowsWorkerOwnership && legacyRegistryDir
			? [registryDir, legacyRegistryDir]
			: [registryDir],
	);
	const registrations = ownershipRegistryDirs.map((candidateRegistryDir) => ({
		registryDir: candidateRegistryDir,
		candidateDirectory: resolve(candidateRegistryDir, `.candidate-${process.pid}-${token}`),
		ownerDirectory: ownerDirectoryPath(candidateRegistryDir, options.generation),
	}));
	const staleDirectories: string[] = [];
	try {
		await withDaemonSupervisorRegistryGuards([...admissionRegistryDirs, ...discoveryRegistryDirs], () => {
			for (const registration of registrations) {
				mkdirPrivateDaemonSupervisorDir(registration.candidateDirectory);
				writeOwnerScope(registration.candidateDirectory, record);
				writeOwnerRecord(registration.candidateDirectory, record);
			}
			for (const candidateRegistryDir of admissionRegistryDirs) {
				if (readActiveShutdownAdmission(candidateRegistryDir)) {
					throw new DaemonShutdownAdmissionError();
				}
			}
			for (const candidateRegistryDir of conflictRegistryDirs) {
				for (const directory of listOwnerDirectories(candidateRegistryDir)) {
					const persistedOwner = readPersistedOwnerRecord(directory);
					if (persistedOwner && ownerConflicts(persistedOwner, record)) {
						const owner = normalizePersistedOwnerRecord(persistedOwner);
						if (owner && isProcessIdentityAlive(owner)) {
							throw new DaemonSupervisorAlreadyRunningError(owner);
						}
						if (!owner && isUnverifiedLegacyOwnerActive(persistedOwner)) {
							throw new Error(`Unverified legacy daemon supervisor still occupies ${persistedOwner.socketPath}`);
						}
						const staleDirectory = `${directory}.stale-${randomUUID()}`;
						renameSync(directory, staleDirectory);
						staleDirectories.push(staleDirectory);
						continue;
					}
					const owner = readOwnerRecordForScope(directory, (scope) => ownerConflicts(scope, record));
					if (!owner || !ownerConflicts(owner, record)) {
						continue;
					}
					if (isProcessIdentityAlive(owner)) {
						throw new DaemonSupervisorAlreadyRunningError(owner);
					}
					const staleDirectory = `${directory}.stale-${randomUUID()}`;
					renameSync(directory, staleDirectory);
					staleDirectories.push(staleDirectory);
				}
			}
			const publishedRegistrations: typeof registrations = [];
			try {
				for (const registration of registrations) {
					renameSync(registration.candidateDirectory, registration.ownerDirectory);
					publishedRegistrations.push(registration);
				}
				recordKnownDaemonAgentDir(registryDir, record.agentDir, record.descriptorDir, registryDir);
				for (const discoveryRegistryDir of discoveryRegistryDirs) {
					if (
						canonicalizeDaemonFilesystemPath(discoveryRegistryDir) !==
						canonicalizeDaemonFilesystemPath(registryDir)
					) {
						recordKnownDaemonAgentDir(discoveryRegistryDir, record.agentDir, record.descriptorDir, registryDir);
					}
				}
			} catch (publicationError) {
				const unwindErrors: unknown[] = [];
				for (const registration of publishedRegistrations.reverse()) {
					try {
						renameSync(registration.ownerDirectory, registration.candidateDirectory);
					} catch (error) {
						unwindErrors.push(error);
					}
				}
				if (unwindErrors.length > 0) {
					throw new AggregateError(
						[publicationError, ...unwindErrors],
						"Failed to publish and unwind daemon supervisor ownership",
					);
				}
				throw publicationError;
			}
		});
	} catch (error) {
		for (const registration of registrations) {
			rmSync(registration.candidateDirectory, { recursive: true, force: true });
		}
		throw error;
	} finally {
		for (const directory of staleDirectories) {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	return new DaemonSupervisorOwnership(record, registryDir, registrations);
}

export async function assertDaemonSupervisorOwnerCurrent(
	owner: {
		generation: string;
		pid: number;
		processStartId?: string;
		socketPath: string;
	},
	validatedFingerprint?: string,
	registryDir?: string,
	legacyRegistryDir: string | undefined = registryDir === undefined
		? implicitLegacyDaemonSupervisorRegistryDir()
		: undefined,
): Promise<string> {
	registryDir ??= defaultDaemonSupervisorRegistryDir();
	const primaryDirectory = ownerDirectoryPath(registryDir, owner.generation);
	const current =
		(process.platform === "win32"
			? readOwnerRecord(primaryDirectory)
			: await withDaemonSupervisorRegistryGuard(registryDir, () => readOwnerRecord(primaryDirectory))) ??
		(legacyRegistryDir ? readOwnerRecord(ownerDirectoryPath(legacyRegistryDir, owner.generation)) : undefined);
	if (
		!current ||
		current.pid !== owner.pid ||
		typeof current.processStartId !== "string" ||
		current.processStartId !== owner.processStartId ||
		current.socketPath !== normalizeSocketPath(owner.socketPath) ||
		!isOwnerProcessAlive(current.pid)
	) {
		throw new DaemonSupervisorOwnershipLostError(owner.generation, { socketPath: owner.socketPath, registryDir });
	}
	const fingerprint = ownerRecordFingerprint(current);
	if (fingerprint !== validatedFingerprint && !matchesExactProcessIdentity(current)) {
		throw new DaemonSupervisorOwnershipLostError(owner.generation, { socketPath: owner.socketPath, registryDir });
	}
	return fingerprint;
}

export async function acquireDaemonShutdownAdmission(
	requestedRegistryDirs?: readonly string[],
): Promise<DaemonShutdownAdmission> {
	const registryDirs = uniqueRegistryDirs([
		...(requestedRegistryDirs ?? []),
		...(await listDaemonSupervisorRegistryDirs()),
	]);
	if (registryDirs.length === 0) {
		throw new Error("Daemon shutdown admission requires at least one supervisor registry");
	}
	const processStartId = getProcessStartId(process.pid);
	if (!processStartId) {
		throw new Error("Cannot acquire daemon shutdown admission without an exact process-start identity");
	}
	while (true) {
		let acquired: DaemonShutdownAdmissionRecord | undefined;
		await withDaemonSupervisorRegistryGuards(registryDirs, () => {
			if (registryDirs.some((candidateRegistryDir) => readActiveShutdownAdmission(candidateRegistryDir))) {
				return;
			}
			const now = Date.now();
			acquired = {
				version: OWNER_VERSION,
				token: randomUUID(),
				pid: process.pid,
				processStartId,
				createdAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				expiresAt: new Date(now + SHUTDOWN_ADMISSION_LEASE_MS).toISOString(),
			};
			const publishedPaths: string[] = [];
			try {
				for (const candidateRegistryDir of registryDirs) {
					const path = shutdownAdmissionPath(candidateRegistryDir);
					writeJsonAtomically(path, acquired);
					publishedPaths.push(path);
				}
			} catch (error) {
				for (const path of publishedPaths) {
					rmSync(path, { force: true });
				}
				throw error;
			}
		});
		if (acquired) {
			return new DaemonShutdownAdmission(acquired, registryDirs);
		}
		await delay(SHUTDOWN_ADMISSION_WAIT_MS);
	}
}

export async function isDaemonShutdownAdmissionActive(): Promise<boolean> {
	const registryDir = defaultDaemonSupervisorRegistryDir();
	return withDaemonSupervisorRegistryGuard(registryDir, () => readActiveShutdownAdmission(registryDir) !== undefined);
}

export async function listDaemonSupervisorProcesses(
	registryDir?: string,
	legacyRegistryDir?: string,
): Promise<DaemonSupervisorProcess[]> {
	const explicitRegistryDirs = daemonSupervisorRegistryDirs(registryDir, legacyRegistryDir);
	let discoveredRegistryDirs: string[] = [];
	if (registryDir === undefined) {
		const discoveryRegistryDir = durableDaemonSupervisorDiscoveryRegistryDir();
		const knownEntries = await withDaemonSupervisorRegistryGuard(discoveryRegistryDir, () =>
			readKnownDaemonAgentDirs(discoveryRegistryDir),
		);
		discoveredRegistryDirs = knownEntries.flatMap((entry) =>
			entry.registryDir && existsSync(entry.registryDir) ? [entry.registryDir] : [],
		);
	}
	const candidateRegistryDirs = uniqueRegistryDirs([...explicitRegistryDirs, ...discoveredRegistryDirs]);
	const discovered = (
		await Promise.all(
			candidateRegistryDirs.map(async (candidateRegistryDir) => {
				try {
					return await withDaemonSupervisorRegistryGuard(candidateRegistryDir, () =>
						listOwnerDirectories(candidateRegistryDir)
							.map((directory) => readOwnerRecord(directory))
							.filter(
								(owner): owner is DaemonSupervisorOwnerRecord =>
									owner?.processStartId !== undefined && matchesExactProcessIdentity(owner),
							)
							.map((owner) => ({
								pid: owner.pid,
								processStartId: owner.processStartId,
								socketPath: owner.socketPath,
								descriptorDir: owner.descriptorDir,
								agentDir: owner.agentDir,
								registryDir: candidateRegistryDir,
							})),
					);
				} catch (error) {
					if (explicitRegistryDirs.includes(candidateRegistryDir)) {
						throw error;
					}
					return [];
				}
			}),
		)
	).flat();
	return [
		...new Map(
			discovered.map((owner) => [
				`${owner.pid}\0${owner.processStartId}\0${owner.socketPath}\0${owner.agentDir}`,
				owner,
			]),
		).values(),
	];
}

export async function listDaemonSupervisorRegistryDirs(): Promise<string[]> {
	const discoveryRegistryDir = durableDaemonSupervisorDiscoveryRegistryDir();
	const knownEntries = await withDaemonSupervisorRegistryGuard(discoveryRegistryDir, () =>
		readKnownDaemonAgentDirs(discoveryRegistryDir),
	);
	return uniqueRegistryDirs([
		defaultDaemonSupervisorRegistryDir(),
		platformDefaultDaemonSupervisorRegistryDir(),
		discoveryRegistryDir,
		...(implicitLegacyDaemonSupervisorRegistryDir() ? [implicitLegacyDaemonSupervisorRegistryDir()!] : []),
		...knownEntries.flatMap((entry) => (entry.registryDir ? [entry.registryDir] : [])),
	]);
}

export async function listDaemonSupervisorAgentDirs(
	registryDir?: string,
	legacyRegistryDir?: string,
): Promise<string[]> {
	const candidateRegistryDirs = uniqueRegistryDirs([
		...daemonSupervisorRegistryDirs(registryDir, legacyRegistryDir),
		...(registryDir === undefined ? [durableDaemonSupervisorDiscoveryRegistryDir()] : []),
	]);
	const discovered = (
		await Promise.all(
			candidateRegistryDirs.map((candidateRegistryDir) =>
				withDaemonSupervisorRegistryGuard(candidateRegistryDir, () => [
					...readKnownDaemonAgentDirs(candidateRegistryDir),
					...listOwnerDirectories(candidateRegistryDir).flatMap((directory) => {
						const persistedOwner = readPersistedOwnerRecord(directory);
						const entry =
							persistedOwner && knownDaemonAgentDirEntry(persistedOwner.agentDir, persistedOwner.descriptorDir);
						if (
							!persistedOwner ||
							!entry ||
							!isExistingCanonicalDaemonAgentDir(entry) ||
							ownerDirectoryPath(candidateRegistryDir, persistedOwner.generation) !== directory
						) {
							return [];
						}
						return [entry];
					}),
				]),
			),
		)
	).flat();
	const entries = newestKnownDaemonAgentDirEntries(discovered);
	const discoveryRegistryDir =
		registryDir === undefined ? durableDaemonSupervisorDiscoveryRegistryDir() : candidateRegistryDirs[0]!;
	await withDaemonSupervisorRegistryGuard(discoveryRegistryDir, () => {
		writeKnownDaemonAgentDirs(discoveryRegistryDir, entries);
	});
	return [...new Set(entries.map((entry) => entry.agentDir))];
}

function daemonSupervisorRegistryDirs(registryDir?: string, legacyRegistryDir?: string): string[] {
	const durableRegistryDir = registryDir ?? defaultDaemonSupervisorRegistryDir();
	const candidateRegistryDirs = [durableRegistryDir];
	if (registryDir === undefined) {
		candidateRegistryDirs.push(platformDefaultDaemonSupervisorRegistryDir());
	}
	const legacyCandidate =
		legacyRegistryDir ??
		(usesDurableWindowsDaemonSupervisorRegistry(durableRegistryDir)
			? legacyWindowsDaemonSupervisorRegistryDir()
			: registryDir === undefined
				? implicitLegacyDaemonSupervisorRegistryDir()
				: undefined);
	if (legacyCandidate && legacyCandidate !== durableRegistryDir && existsSync(legacyCandidate)) {
		candidateRegistryDirs.push(legacyCandidate);
	}
	return uniqueRegistryDirs(candidateRegistryDirs);
}

function usesDurableWindowsDaemonSupervisorRegistry(registryDir: string): boolean {
	return (
		process.platform === "win32" &&
		canonicalizeDaemonFilesystemPath(registryDir) ===
			canonicalizeDaemonFilesystemPath(platformDefaultDaemonSupervisorRegistryDir())
	);
}

function migratedDaemonSupervisorRegistryDir(
	sourceRegistryDir: string,
	registryDir?: string,
	legacyRegistryDir?: string,
): string {
	const canonicalSource = canonicalizeDaemonFilesystemPath(sourceRegistryDir);
	if (registryDir && legacyRegistryDir && canonicalSource === canonicalizeDaemonFilesystemPath(legacyRegistryDir)) {
		return registryDir;
	}
	if (
		process.platform === "win32" &&
		canonicalSource === canonicalizeDaemonFilesystemPath(legacyWindowsDaemonSupervisorRegistryDir())
	) {
		return platformDefaultDaemonSupervisorRegistryDir();
	}
	return sourceRegistryDir;
}

export function daemonSupervisorSuccessorRegistryDir(registryDir: string): string {
	return migratedDaemonSupervisorRegistryDir(registryDir);
}

async function persistFenceFromReadOnlyLegacy(
	socketPath: string,
	hello: DaemonSupervisorHelloIdentity,
	registryDir: string,
	legacyRegistryDir: string,
): Promise<string> {
	const fenceDirectory = resolve(registryDir, "startup-fences");
	const path = startupFencePath(fenceDirectory, socketPath);
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	await withDaemonSupervisorRegistryGuard(registryDir, () => {
		mkdirPrivateDaemonSupervisorDir(fenceDirectory, true);
		const owners = existsSync(registryDir)
			? listOwnerDirectories(registryDir).flatMap((directory) => {
					const owner = readOwnerRecord(directory);
					return owner?.socketPath === normalizedSocketPath ? [owner] : [];
				})
			: [];
		let matchingOwners = owners.filter((owner) => owner.socketPath === normalizedSocketPath);
		if (matchingOwners.length === 0) {
			matchingOwners = readLegacyOwnersForSocket(legacyRegistryDir, normalizedSocketPath).filter(
				(owner) => owner.token === hello.supervisorOwnerToken && owner.pid === hello.supervisorPid,
			);
		}
		if (matchingOwners.length === 0) {
			throw new Error(`Daemon supervisor owner does not match ${socketPath}`);
		}
		if (matchingOwners.length > 1) {
			throw new Error(`Multiple daemon supervisor owners match ${socketPath}`);
		}
		const owner = matchingOwners[0];
		if (!owner) {
			throw new Error(`Daemon supervisor owner disappeared for ${socketPath}`);
		}
		const helloSocketPath = hello.supervisorSocketPath;
		if (
			!Number.isInteger(hello.supervisorPid) ||
			hello.supervisorPid !== owner.pid ||
			hello.supervisorGeneration !== owner.generation ||
			hello.supervisorOwnerToken !== owner.token ||
			typeof helloSocketPath !== "string" ||
			normalizeSocketPath(helloSocketPath) !== owner.socketPath ||
			typeof owner.processStartId !== "string" ||
			hello.supervisorProcessStartId !== owner.processStartId
		) {
			throw new Error(`Daemon supervisor hello does not match its durable owner for ${socketPath}`);
		}
		const observedProcessStartId = getProcessStartId(owner.pid);
		if (observedProcessStartId !== owner.processStartId) {
			throw new Error(`Daemon supervisor process identity changed for ${socketPath}`);
		}
		const record: DaemonStartupFenceRecord = {
			version: OWNER_VERSION,
			token: randomUUID(),
			ownerToken: owner.token,
			pid: owner.pid,
			processStartId: owner.processStartId,
			socketPath: owner.socketPath,
			supervisorGeneration: owner.generation,
			createdAt: new Date().toISOString(),
		};
		writeJsonAtomically(path, record);
	});
	return registryDir;
}

export async function persistDaemonStartupFenceFromOwner(
	socketPath: string,
	hello: DaemonSupervisorHelloIdentity,
	registryDir?: string,
	legacyRegistryDir?: string,
): Promise<string> {
	if (registryDir !== undefined && legacyRegistryDir !== undefined) {
		return persistFenceFromReadOnlyLegacy(socketPath, hello, registryDir, legacyRegistryDir);
	}
	const adoptedRegistryDir = await adoptLegacyDaemonSupervisorOwnershipFromHello(
		socketPath,
		hello,
		registryDir,
		legacyRegistryDir,
	);
	const durableRegistryDir = adoptedRegistryDir ?? registryDir ?? defaultDaemonSupervisorRegistryDir();
	const candidateRegistryDirs = uniqueRegistryDirs([
		durableRegistryDir,
		...daemonSupervisorRegistryDirs(registryDir, legacyRegistryDir),
	]);
	let owner: DaemonSupervisorOwnerRecord | undefined;
	let ownerRegistryDir: string | undefined;
	for (const candidateRegistryDir of candidateRegistryDirs) {
		owner = await withDaemonSupervisorRegistryGuard(candidateRegistryDir, () =>
			findDaemonSupervisorOwnerForHello(candidateRegistryDir, socketPath, hello),
		);
		if (owner) {
			ownerRegistryDir = candidateRegistryDir;
			break;
		}
	}
	if (!owner || !ownerRegistryDir) {
		throw new Error(`Daemon supervisor owner does not match ${socketPath}`);
	}
	const authoritativeRegistryDir = migratedDaemonSupervisorRegistryDir(
		ownerRegistryDir,
		registryDir,
		legacyRegistryDir,
	);
	const fenceDirectory = resolve(authoritativeRegistryDir, "startup-fences");
	const path = startupFencePath(fenceDirectory, socketPath);
	await withDaemonSupervisorRegistryGuard(authoritativeRegistryDir, () => {
		mkdirPrivateDaemonSupervisorDir(fenceDirectory, true);
		const record: DaemonStartupFenceRecord = {
			version: OWNER_VERSION,
			token: randomUUID(),
			ownerToken: owner.token,
			pid: owner.pid,
			processStartId: owner.processStartId,
			socketPath: owner.socketPath,
			supervisorGeneration: owner.generation,
			createdAt: new Date().toISOString(),
		};
		writeJsonAtomically(path, record);
	});
	return authoritativeRegistryDir;
}

export async function adoptLegacyDaemonSupervisorOwnershipFromHello(
	socketPath: string,
	hello: DaemonSupervisorHelloIdentity,
	registryDir?: string,
	legacyRegistryDir?: string,
): Promise<string | undefined> {
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	if (
		!Number.isInteger(hello.supervisorPid) ||
		(hello.supervisorPid ?? 0) <= 0 ||
		typeof hello.supervisorGeneration !== "string" ||
		typeof hello.supervisorOwnerToken !== "string" ||
		typeof hello.supervisorSocketPath !== "string" ||
		normalizeSocketPath(hello.supervisorSocketPath) !== normalizedSocketPath
	) {
		return undefined;
	}
	let discoveredRegistryDirs: string[] = [];
	if (registryDir === undefined) {
		const discoveryRegistryDir = durableDaemonSupervisorDiscoveryRegistryDir();
		const knownEntries = await withDaemonSupervisorRegistryGuard(discoveryRegistryDir, () =>
			readKnownDaemonAgentDirs(discoveryRegistryDir),
		);
		discoveredRegistryDirs = knownEntries.flatMap((entry) =>
			entry.registryDir && existsSync(entry.registryDir) ? [entry.registryDir] : [],
		);
	}
	const candidateRegistryDirs = uniqueRegistryDirs([
		...daemonSupervisorRegistryDirs(registryDir, legacyRegistryDir),
		...discoveredRegistryDirs,
	]);
	let authoritativeRegistryDir: string | undefined;
	const discoveryRegistryDirs =
		registryDir === undefined ? uniqueRegistryDirs([durableDaemonSupervisorDiscoveryRegistryDir()]) : [];
	await withDaemonSupervisorRegistryGuards([...candidateRegistryDirs, ...discoveryRegistryDirs], () => {
		const matches: Array<{
			owner: PersistedDaemonSupervisorOwnerRecord;
			ownerDirectory: string;
			registryDir: string;
		}> = [];
		let hasConflictingLiveOwner = false;
		for (const candidateRegistryDir of candidateRegistryDirs) {
			for (const ownerDirectory of listOwnerDirectories(candidateRegistryDir)) {
				const owner = readPersistedOwnerRecord(ownerDirectory);
				if (owner?.socketPath !== normalizedSocketPath) {
					continue;
				}
				if (
					owner.generation === hello.supervisorGeneration &&
					owner.token === hello.supervisorOwnerToken &&
					owner.pid === hello.supervisorPid
				) {
					matches.push({ owner, ownerDirectory, registryDir: candidateRegistryDir });
				} else {
					const normalizedOwner = normalizePersistedOwnerRecord(owner);
					hasConflictingLiveOwner ||=
						owner.pid === hello.supervisorPid ||
						(normalizedOwner !== undefined && matchesExactProcessIdentity(normalizedOwner)) ||
						isUnverifiedLegacyOwnerActive(owner);
				}
			}
		}
		if (matches.length === 0) {
			if (hasConflictingLiveOwner) {
				throw new Error(`Daemon supervisor hello conflicts with its durable owner for ${socketPath}`);
			}
			return;
		}
		const observedProcessStartId = getProcessStartId(hello.supervisorPid!);
		if (
			!observedProcessStartId ||
			(hello.supervisorProcessStartId !== undefined && hello.supervisorProcessStartId !== observedProcessStartId)
		) {
			throw new Error(`Daemon supervisor process identity changed for ${socketPath}`);
		}
		const bindings = matches.flatMap(({ owner }) => {
			const agentDir = daemonAgentDirFromOwner(owner);
			return agentDir
				? [
						{
							agentDir,
							descriptorDir: canonicalizeDaemonFilesystemPath(owner.descriptorDir),
						},
					]
				: [];
		});
		if (bindings.length !== matches.length) {
			throw new Error(`Legacy daemon supervisor owner has no valid agent directory for ${socketPath}`);
		}
		const distinctBindings = new Set(bindings.map(({ agentDir, descriptorDir }) => `${agentDir}\0${descriptorDir}`));
		if (distinctBindings.size !== 1) {
			throw new Error(`Legacy daemon supervisor owners disagree on their agent directory for ${socketPath}`);
		}
		const agentDir = bindings[0]!.agentDir;
		const source = matches[0]!;
		const targetRegistryDir = migratedDaemonSupervisorRegistryDir(source.registryDir, registryDir, legacyRegistryDir);
		authoritativeRegistryDir = targetRegistryDir;
		const upgraded: DaemonSupervisorOwnerRecord = {
			...source.owner,
			processStartId: observedProcessStartId,
			agentDir,
			updatedAt: new Date().toISOString(),
		};
		const authoritativeOwnerDirectory = ownerDirectoryPath(targetRegistryDir, upgraded.generation);
		const existingAuthoritative = readPersistedOwnerRecord(authoritativeOwnerDirectory);
		if (
			existingAuthoritative &&
			(existingAuthoritative.token !== upgraded.token ||
				existingAuthoritative.pid !== upgraded.pid ||
				existingAuthoritative.generation !== upgraded.generation ||
				existingAuthoritative.socketPath !== upgraded.socketPath ||
				canonicalizeDaemonFilesystemPath(existingAuthoritative.descriptorDir) !== upgraded.descriptorDir ||
				(existingAuthoritative.agentDir !== undefined &&
					canonicalizeDaemonFilesystemPath(existingAuthoritative.agentDir) !== upgraded.agentDir) ||
				(existingAuthoritative.processStartId !== undefined &&
					existingAuthoritative.processStartId !== upgraded.processStartId))
		) {
			throw new Error(`Conflicting daemon supervisor owner prevents migration for ${socketPath}`);
		}
		if (!existingAuthoritative) {
			const candidateDirectory = resolve(targetRegistryDir, `.candidate-${process.pid}-${randomUUID()}`);
			mkdirPrivateDaemonSupervisorDir(candidateDirectory);
			try {
				writeOwnerScope(candidateDirectory, upgraded);
				writeOwnerRecord(candidateDirectory, upgraded);
				renameSync(candidateDirectory, authoritativeOwnerDirectory);
			} finally {
				rmSync(candidateDirectory, { recursive: true, force: true });
			}
		}
		for (const match of matches) {
			writeOwnerScope(match.ownerDirectory, upgraded);
			writeOwnerRecord(match.ownerDirectory, upgraded);
		}
		recordKnownDaemonAgentDir(targetRegistryDir, upgraded.agentDir, upgraded.descriptorDir, targetRegistryDir);
		for (const discoveryRegistryDir of discoveryRegistryDirs) {
			if (
				canonicalizeDaemonFilesystemPath(discoveryRegistryDir) !==
				canonicalizeDaemonFilesystemPath(targetRegistryDir)
			) {
				recordKnownDaemonAgentDir(
					discoveryRegistryDir,
					upgraded.agentDir,
					upgraded.descriptorDir,
					targetRegistryDir,
				);
			}
		}
	});
	return authoritativeRegistryDir;
}

function findDaemonSupervisorOwnerForHello(
	registryDir: string,
	socketPath: string,
	hello: DaemonSupervisorHelloIdentity,
): DaemonSupervisorOwnerRecord | undefined {
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	const matchingOwners = listOwnerDirectories(registryDir).flatMap((directory) => {
		const owner = readOwnerRecordForScope(directory, (scope) => scope.socketPath === normalizedSocketPath);
		return owner?.socketPath === normalizedSocketPath ? [owner] : [];
	});
	if (matchingOwners.length === 0) return undefined;
	if (matchingOwners.length > 1) {
		throw new Error(`Multiple daemon supervisor owners match ${socketPath}`);
	}
	const owner = matchingOwners[0];
	if (!owner) return undefined;
	const helloSocketPath = hello.supervisorSocketPath;
	if (
		!Number.isInteger(hello.supervisorPid) ||
		hello.supervisorPid !== owner.pid ||
		hello.supervisorGeneration !== owner.generation ||
		hello.supervisorOwnerToken !== owner.token ||
		typeof helloSocketPath !== "string" ||
		normalizeSocketPath(helloSocketPath) !== owner.socketPath ||
		typeof owner.processStartId !== "string" ||
		(hello.supervisorProcessStartId !== undefined && hello.supervisorProcessStartId !== owner.processStartId)
	) {
		throw new Error(`Daemon supervisor hello does not match its durable owner for ${socketPath}`);
	}
	const observedProcessStartId = getProcessStartId(owner.pid);
	if (observedProcessStartId !== owner.processStartId) {
		throw new Error(`Daemon supervisor process identity changed for ${socketPath}`);
	}
	return owner;
}

export async function waitForDaemonStartupFence(
	socketPath: string,
	timeoutMs = 10_000,
	registryDir: string = defaultDaemonSupervisorRegistryDir(),
): Promise<void> {
	const path = startupFencePath(resolve(registryDir, "startup-fences"), socketPath);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const fence = await withDaemonSupervisorRegistryGuard(registryDir, () => readStartupFence(path));
		if (!fence) {
			return;
		}
		if (fence.socketPath !== normalizeSocketPath(socketPath)) {
			throw new Error(`Daemon startup fence does not match ${socketPath}`);
		}
		if (!isProcessIdentityAlive(fence)) {
			const cleared = await withDaemonSupervisorRegistryGuard(registryDir, () => {
				const current = readStartupFence(path);
				if (!current) {
					return true;
				}
				if (current?.token === fence.token) {
					rmSync(path, { force: true });
					return true;
				}
				return false;
			});
			if (cleared) {
				return;
			}
			continue;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for predecessor daemon process ${fence.pid} to exit`);
		}
		await delay(STARTUP_FENCE_POLL_MS);
	}
}

function isProcessIdentityAlive(identity: ProcessIdentity): boolean {
	if (!isOwnerProcessAlive(identity.pid)) {
		return false;
	}
	if (!identity.processStartId) {
		return true;
	}
	const observed = getProcessStartId(identity.pid);
	return observed === undefined || observed === identity.processStartId;
}

function matchesExactProcessIdentity(identity: ProcessIdentity): boolean {
	if (!isOwnerProcessAlive(identity.pid)) {
		return false;
	}
	return typeof identity.processStartId === "string" && getProcessStartId(identity.pid) === identity.processStartId;
}

// The 250ms fence poll must not spawn `ps` (macOS/BSD zombie check) per tick; existence stays kill(0)-checked every tick.
const OWNER_ZOMBIE_CONFIRM_INTERVAL_MS = 5000;
const ownerZombieConfirmations = new Map<number, number>();

function isOwnerProcessAlive(pid: number): boolean {
	if (!processIdExists(pid)) {
		ownerZombieConfirmations.delete(pid);
		return false;
	}
	const now = Date.now();
	const confirmedAt = ownerZombieConfirmations.get(pid);
	if (confirmedAt !== undefined && now - confirmedAt < OWNER_ZOMBIE_CONFIRM_INTERVAL_MS) {
		return true;
	}
	if (isZombieProcess(pid)) {
		ownerZombieConfirmations.delete(pid);
		return false;
	}
	for (const [staleOwnerPid, staleConfirmedAt] of ownerZombieConfirmations) {
		if (now - staleConfirmedAt >= OWNER_ZOMBIE_CONFIRM_INTERVAL_MS) {
			ownerZombieConfirmations.delete(staleOwnerPid);
		}
	}
	ownerZombieConfirmations.set(pid, now);
	return true;
}

function ownerConflicts(
	left: PersistedDaemonSupervisorOwnerScope,
	right: PersistedDaemonSupervisorOwnerScope,
): boolean {
	return (
		left.socketPath === right.socketPath ||
		left.descriptorDir === right.descriptorDir ||
		(left.agentDir !== undefined && right.agentDir !== undefined && left.agentDir === right.agentDir)
	);
}

function uniqueRegistryDirs(registryDirs: readonly string[]): string[] {
	return [
		...new Map(
			registryDirs.map((registryDir) => [canonicalizeDaemonFilesystemPath(registryDir), registryDir]),
		).values(),
	];
}

function sameOwnerRecord(left: DaemonSupervisorOwnerRecord, right: DaemonSupervisorOwnerRecord): boolean {
	return (
		left.token === right.token &&
		left.generation === right.generation &&
		left.pid === right.pid &&
		left.processStartId === right.processStartId &&
		left.socketPath === right.socketPath
	);
}

function sameShutdownAdmission(
	left: DaemonShutdownAdmissionRecord | undefined,
	right: DaemonShutdownAdmissionRecord,
): left is DaemonShutdownAdmissionRecord {
	return (
		left !== undefined &&
		left.token === right.token &&
		left.pid === right.pid &&
		left.processStartId === right.processStartId &&
		Date.parse(left.expiresAt) > Date.now()
	);
}

function ownerRecordFingerprint(record: DaemonSupervisorOwnerRecord): string {
	return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function listOwnerDirectories(registryDir: string): string[] {
	return readdirSync(registryDir)
		.filter((name) => name.endsWith(".owner"))
		.map((name) => resolve(registryDir, name));
}

function ownerDirectoryPath(registryDir: string, generation: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(generation)) {
		throw new Error(`Invalid daemon supervisor generation: ${generation}`);
	}
	return resolve(registryDir, `${generation}.owner`);
}

function readOwnerRecordForScope(
	directory: string,
	isRelevant: (scope: PersistedDaemonSupervisorOwnerScope) => boolean,
): DaemonSupervisorOwnerRecord | undefined {
	const owner = readOwnerRecord(directory);
	if (owner) {
		return owner;
	}
	const scope = readOwnerScope(directory);
	const entries = !scope ? readdirSync(directory) : [];
	if (!scope && !entries.includes("owner.json") && !entries.includes("scope.json")) {
		const abandonedDirectory = `${directory}.abandoned-${randomUUID()}`;
		renameSync(directory, abandonedDirectory);
		rmSync(abandonedDirectory, { recursive: true, force: true });
		return undefined;
	}
	if (!scope || isRelevant(scope)) {
		throw new Error(`Invalid daemon supervisor owner record: ${directory}`);
	}
	return undefined;
}

function readOwnerRecord(directory: string): DaemonSupervisorOwnerRecord | undefined {
	const persisted = readPersistedOwnerRecord(directory);
	return persisted ? normalizePersistedOwnerRecord(persisted) : undefined;
}

function readPersistedOwnerRecord(directory: string): PersistedDaemonSupervisorOwnerRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(resolve(directory, "owner.json"), "utf8")) as unknown;
		if (!isPersistedDaemonSupervisorOwnerRecord(value)) {
			return undefined;
		}
		const agentDir = daemonAgentDirFromOwner(value);
		return {
			...value,
			socketPath: normalizeSocketPath(value.socketPath),
			descriptorDir: canonicalizeDaemonFilesystemPath(value.descriptorDir),
			...(agentDir ? { agentDir } : {}),
		};
	} catch {
		return undefined;
	}
}

function isDaemonSupervisorOwnerRecord(value: unknown): value is DaemonSupervisorOwnerRecord {
	const record = normalizePersistedOwnerRecord(value);
	return record !== undefined;
}

function normalizePersistedOwnerRecord(value: unknown): DaemonSupervisorOwnerRecord | undefined {
	if (!isPersistedDaemonSupervisorOwnerRecord(value) || typeof value.processStartId !== "string") {
		return undefined;
	}
	const agentDir = daemonAgentDirFromOwner(value);
	if (!agentDir) {
		return undefined;
	}
	return {
		...value,
		socketPath: normalizeSocketPath(value.socketPath),
		descriptorDir: canonicalizeDaemonFilesystemPath(value.descriptorDir),
		agentDir,
		processStartId: value.processStartId,
	};
}

function isPersistedDaemonSupervisorOwnerRecord(value: unknown): value is PersistedDaemonSupervisorOwnerRecord {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Partial<PersistedDaemonSupervisorOwnerRecord>;
	return (
		record.version === OWNER_VERSION &&
		record.role === "supervisor" &&
		typeof record.token === "string" &&
		typeof record.generation === "string" &&
		Number.isInteger(record.pid) &&
		(record.pid ?? 0) > 0 &&
		(record.processStartId === undefined || typeof record.processStartId === "string") &&
		typeof record.socketPath === "string" &&
		typeof record.descriptorDir === "string" &&
		(record.agentDir === undefined || typeof record.agentDir === "string") &&
		typeof record.appVersion === "string" &&
		(record.phase === "starting" || record.phase === "owner" || record.phase === "stopping") &&
		typeof record.createdAt === "string" &&
		typeof record.updatedAt === "string"
	);
}

function readOwnerScope(directory: string): PersistedDaemonSupervisorOwnerScope | undefined {
	try {
		const value = JSON.parse(readFileSync(resolve(directory, "scope.json"), "utf8")) as unknown;
		if (!isDaemonSupervisorOwnerScope(value)) {
			return undefined;
		}
		if (ownerDirectoryPath(dirname(directory), value.generation) !== directory) {
			return undefined;
		}
		const agentDir = daemonAgentDirFromOwner(value);
		return {
			...value,
			socketPath: normalizeSocketPath(value.socketPath),
			descriptorDir: canonicalizeDaemonFilesystemPath(value.descriptorDir),
			...(agentDir ? { agentDir } : {}),
		};
	} catch {
		return undefined;
	}
}

function isDaemonSupervisorOwnerScope(value: unknown): value is PersistedDaemonSupervisorOwnerScope {
	if (!value || typeof value !== "object") {
		return false;
	}
	const scope = value as Partial<PersistedDaemonSupervisorOwnerScope>;
	return (
		scope.version === OWNER_VERSION &&
		scope.role === "supervisor" &&
		typeof scope.token === "string" &&
		typeof scope.generation === "string" &&
		typeof scope.socketPath === "string" &&
		typeof scope.descriptorDir === "string" &&
		(scope.agentDir === undefined || typeof scope.agentDir === "string")
	);
}

function daemonAgentDirFromOwner(
	owner: Pick<PersistedDaemonSupervisorOwnerRecord, "agentDir" | "descriptorDir">,
): string | undefined {
	if (owner.agentDir) {
		return canonicalizeDaemonFilesystemPath(owner.agentDir);
	}
	const descriptorDir = canonicalizeDaemonFilesystemPath(owner.descriptorDir);
	const workerRoot = dirname(descriptorDir);
	if (basename(workerRoot).toLowerCase() !== "daemon-workers") {
		return undefined;
	}
	return canonicalizeDaemonFilesystemPath(dirname(workerRoot));
}

function isUnverifiedLegacyOwnerActive(owner: PersistedDaemonSupervisorOwnerRecord): boolean {
	if (!isOwnerProcessAlive(owner.pid)) {
		return false;
	}
	if (owner.processStartId) {
		const observedProcessStartId = getProcessStartId(owner.pid);
		return observedProcessStartId === undefined || observedProcessStartId === owner.processStartId;
	}
	if (process.platform === "win32" && owner.phase === "owner" && isWindowsNamedPipePresent(owner.socketPath)) {
		return true;
	}
	const updatedAt = Date.parse(owner.updatedAt);
	return Number.isFinite(updatedAt) && Date.now() - updatedAt <= LEGACY_OWNER_STARTUP_GRACE_MS;
}

function knownDaemonAgentDirEntry(
	agentDir: string | undefined,
	descriptorDir: string,
	updatedAt = new Date().toISOString(),
	registryDir?: string,
): KnownDaemonAgentDirEntry | undefined {
	if (!agentDir) return undefined;
	const canonicalAgentDir = canonicalizeDaemonFilesystemPath(agentDir);
	const canonicalDescriptorDir = canonicalizeDaemonFilesystemPath(descriptorDir);
	const descriptorRoot = canonicalizeDaemonFilesystemPath(join(canonicalAgentDir, "daemon-workers"));
	if (dirname(canonicalDescriptorDir) !== descriptorRoot || basename(canonicalDescriptorDir).length === 0) {
		return undefined;
	}
	if (registryDir !== undefined && !isAbsolute(registryDir)) {
		return undefined;
	}
	return {
		agentDir: canonicalAgentDir,
		descriptorRoot,
		...(registryDir !== undefined ? { registryDir: resolve(registryDir) } : {}),
		updatedAt,
	};
}

function isExistingCanonicalDaemonAgentDir(entry: KnownDaemonAgentDirEntry): boolean {
	if (
		canonicalizeDaemonFilesystemPath(entry.agentDir) !== entry.agentDir ||
		canonicalizeDaemonFilesystemPath(entry.descriptorRoot) !== entry.descriptorRoot ||
		entry.descriptorRoot !== canonicalizeDaemonFilesystemPath(join(entry.agentDir, "daemon-workers"))
	) {
		return false;
	}
	try {
		return statSync(entry.agentDir).isDirectory() && statSync(entry.descriptorRoot).isDirectory();
	} catch {
		return false;
	}
}

function readKnownDaemonAgentDirs(registryDir: string): KnownDaemonAgentDirEntry[] {
	try {
		const value = JSON.parse(readFileSync(resolve(registryDir, KNOWN_AGENT_DIRS_FILE_NAME), "utf8")) as unknown;
		if (!value || typeof value !== "object") {
			return [];
		}
		const record = value as Partial<KnownDaemonAgentDirsRecord> & { agentDirs?: unknown };
		if (record.version !== OWNER_VERSION) {
			return [];
		}
		const entries = Array.isArray(record.entries)
			? record.entries.flatMap((entry) => {
					if (
						!entry ||
						typeof entry !== "object" ||
						typeof (entry as Partial<KnownDaemonAgentDirEntry>).agentDir !== "string" ||
						typeof (entry as Partial<KnownDaemonAgentDirEntry>).descriptorRoot !== "string" ||
						((entry as Partial<KnownDaemonAgentDirEntry>).registryDir !== undefined &&
							(typeof (entry as Partial<KnownDaemonAgentDirEntry>).registryDir !== "string" ||
								!isAbsolute((entry as KnownDaemonAgentDirEntry).registryDir!))) ||
						typeof (entry as Partial<KnownDaemonAgentDirEntry>).updatedAt !== "string" ||
						!Number.isFinite(Date.parse((entry as KnownDaemonAgentDirEntry).updatedAt))
					) {
						return [];
					}
					return [entry as KnownDaemonAgentDirEntry];
				})
			: Array.isArray(record.agentDirs)
				? record.agentDirs.flatMap((agentDir) => {
						if (typeof agentDir !== "string") return [];
						return [
							{
								agentDir,
								descriptorRoot: join(agentDir, "daemon-workers"),
								updatedAt: new Date(0).toISOString(),
							} satisfies KnownDaemonAgentDirEntry,
						];
					})
				: [];
		return newestKnownDaemonAgentDirEntries(entries.filter(isExistingCanonicalDaemonAgentDir));
	} catch {
		return [];
	}
}

function writeKnownDaemonAgentDirs(registryDir: string, entries: readonly KnownDaemonAgentDirEntry[]): void {
	const boundedEntries = newestKnownDaemonAgentDirEntries(entries);
	writeJsonAtomically(resolve(registryDir, KNOWN_AGENT_DIRS_FILE_NAME), {
		version: OWNER_VERSION,
		entries: boundedEntries,
	} satisfies KnownDaemonAgentDirsRecord);
}

function newestKnownDaemonAgentDirEntries(entries: readonly KnownDaemonAgentDirEntry[]): KnownDaemonAgentDirEntry[] {
	const newestByIdentity = new Map<string, KnownDaemonAgentDirEntry>();
	for (const entry of entries) {
		const key = `${entry.agentDir}\0${entry.descriptorRoot}`;
		const existing = newestByIdentity.get(key);
		if (!existing || Date.parse(entry.updatedAt) > Date.parse(existing.updatedAt)) {
			newestByIdentity.set(key, entry);
		}
	}
	return [...newestByIdentity.values()]
		.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
		.slice(0, MAX_KNOWN_AGENT_DIRS);
}

function recordKnownDaemonAgentDir(
	registryDir: string,
	agentDir: string,
	descriptorDir: string,
	ownerRegistryDir = registryDir,
): void {
	const entry = knownDaemonAgentDirEntry(agentDir, descriptorDir, new Date().toISOString(), ownerRegistryDir);
	if (!entry) return;
	writeKnownDaemonAgentDirs(registryDir, [entry, ...readKnownDaemonAgentDirs(registryDir)]);
}

function writeOwnerScope(directory: string, owner: DaemonSupervisorOwnerRecord): void {
	const scope: DaemonSupervisorOwnerScope = {
		version: owner.version,
		role: owner.role,
		token: owner.token,
		generation: owner.generation,
		socketPath: owner.socketPath,
		descriptorDir: owner.descriptorDir,
		agentDir: owner.agentDir,
	};
	writeJsonAtomically(resolve(directory, "scope.json"), scope);
}

function writeOwnerRecord(directory: string, record: DaemonSupervisorOwnerRecord): void {
	writeJsonAtomically(resolve(directory, "owner.json"), record);
}

function readStartupFence(path: string): DaemonStartupFenceRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object") {
			throw new Error(`Invalid daemon startup fence: ${path}`);
		}
		const fence = value as Partial<DaemonStartupFenceRecord>;
		if (
			fence.version !== OWNER_VERSION ||
			typeof fence.token !== "string" ||
			typeof fence.ownerToken !== "string" ||
			!Number.isInteger(fence.pid) ||
			(fence.pid ?? 0) <= 0 ||
			typeof fence.processStartId !== "string" ||
			typeof fence.socketPath !== "string" ||
			typeof fence.supervisorGeneration !== "string" ||
			typeof fence.createdAt !== "string"
		) {
			throw new Error(`Invalid daemon startup fence: ${path}`);
		}
		return fence as DaemonStartupFenceRecord;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function readActiveShutdownAdmission(registryDir: string): DaemonShutdownAdmissionRecord | undefined {
	const path = shutdownAdmissionPath(registryDir);
	const admission = readShutdownAdmission(path);
	if (!admission) {
		return undefined;
	}
	if (Date.parse(admission.expiresAt) > Date.now() && isProcessIdentityAlive(admission)) {
		return admission;
	}
	rmSync(path, { force: true });
	return undefined;
}

function readShutdownAdmission(path: string): DaemonShutdownAdmissionRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object") {
			throw new Error(`Invalid daemon shutdown admission: ${path}`);
		}
		const admission = value as Partial<DaemonShutdownAdmissionRecord>;
		if (
			admission.version !== OWNER_VERSION ||
			typeof admission.token !== "string" ||
			!Number.isInteger(admission.pid) ||
			(admission.pid ?? 0) <= 0 ||
			(admission.processStartId !== undefined && typeof admission.processStartId !== "string") ||
			typeof admission.createdAt !== "string" ||
			typeof admission.updatedAt !== "string" ||
			typeof admission.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(admission.expiresAt))
		) {
			throw new Error(`Invalid daemon shutdown admission: ${path}`);
		}
		return admission as DaemonShutdownAdmissionRecord;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function writeJsonAtomically(path: string, value: unknown): void {
	writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function startupFencePath(directory: string, socketPath: string): string {
	const key = createHash("sha256").update(normalizeSocketPath(socketPath)).digest("hex");
	return resolve(directory, `${key}.json`);
}

function shutdownAdmissionPath(registryDir: string): string {
	return resolve(registryDir, SHUTDOWN_ADMISSION_FILE_NAME);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
