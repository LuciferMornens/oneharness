import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getPackageDir, VERSION } from "../../config.js";
import { getCurrentProcessStartId, getProcessStartId } from "../session-lease.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";

const BOOTSTRAP_SCHEMA = 9;
const PYTHON_VERSION = "3.11";
const RUNTIME_REQUIREMENT = "prime-agent-runtime";
// Serializes the kernel's user namespace so it can be revived across session
// resume. Internal-only; intentionally not surfaced to the model as an import.
const STATE_SNAPSHOT_REQUIREMENT = "dill";
const DEFAULT_RLM_EXTRA_PACKAGES = [
	{ uvArg: "requests", importName: "requests", promptLabel: "requests" },
	{ uvArg: "httpx", importName: "httpx", promptLabel: "httpx" },
	{ uvArg: "pyyaml", importName: "yaml", promptLabel: "yaml (PyYAML)" },
	{ uvArg: "tomli", importName: "tomli", promptLabel: "tomli" },
	{ uvArg: "python-dotenv", importName: "dotenv", promptLabel: "dotenv (python-dotenv)" },
	{ uvArg: "pandas", importName: "pandas", promptLabel: "pandas" },
	{ uvArg: "numpy", importName: "numpy", promptLabel: "numpy" },
	{ uvArg: "scipy", importName: "scipy", promptLabel: "scipy" },
	{ uvArg: "beautifulsoup4", importName: "bs4", promptLabel: "bs4 (Beautiful Soup)" },
	{ uvArg: "lxml", importName: "lxml", promptLabel: "lxml" },
	{ uvArg: "pydantic", importName: "pydantic", promptLabel: "pydantic" },
	{ uvArg: "tyro", importName: "tyro", promptLabel: "tyro" },
];
export const DEFAULT_RLM_EXTRA_UV_ARGS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.uvArg);
export const DEFAULT_RLM_EXTRA_IMPORT_NAMES = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.importName);
export const DEFAULT_RLM_EXTRA_IMPORT_LABELS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.promptLabel);
const UV_INSTALL_COMMAND_UNIX = "curl -LsSf https://astral.sh/uv/install.sh | sh";
const UV_INSTALL_COMMAND_WINDOWS = "irm https://astral.sh/uv/install.ps1 | iex";
const REQUIRED_HARNESS_METHODS = [
	"create_memory",
	"update_memory",
	"delete_memory",
	"create_skill",
	"update_skill",
	"delete_skill",
	"create_subagent",
	"update_subagent",
	"delete_subagent",
	"create_prompt_note",
	"update_prompt_note",
	"delete_prompt_note",
	"record_refinement",
];
const RUNTIME_READY_CHECK = `import inspect; import rlm; from rlm import McpIntegration; import rlm.mcp as mcp; from rlm.harness import HarnessEntry; _harness_methods = ${JSON.stringify(REQUIRED_HARNESS_METHODS)}; assert callable(mcp.list_tools); assert callable(mcp.call_tool); assert hasattr(rlm, 'run'); assert callable(rlm); assert hasattr(rlm, 'rlm'); assert callable(rlm.rlm); assert callable(rlm.host_request); assert callable(rlm.find_models); assert callable(rlm.rlm.find_models); assert hasattr(rlm, 'harness'); assert hasattr(rlm, 'get_harness_state'); assert hasattr(rlm.rlm, 'harness'); assert hasattr(rlm.rlm, 'get_harness_state'); assert all(callable(getattr(_harness, _method, None)) for _harness in (rlm.harness, rlm.rlm.harness) for _method in _harness_methods); assert 'reference' in HarnessEntry.__dataclass_fields__; assert 'scope' in HarnessEntry.__dataclass_fields__; assert 'reference' in inspect.signature(rlm.harness.create_skill).parameters; assert 'reference' in inspect.signature(rlm.harness.update_skill).parameters; assert 'global_' in inspect.signature(rlm.harness.create_memory).parameters; assert 'global_' in inspect.signature(rlm.get_harness_state).parameters; assert not hasattr(rlm, 'background'); assert not hasattr(rlm.rlm, 'background'); from rlm.bash import BashHandle, BashResult; assert callable(rlm.bash); assert all(callable(getattr(BashHandle, _m, None)) for _m in ('tail', 'output', 'poll', 'kill')); assert {'exit_code', 'output', 'duration'} <= set(BashResult.__dataclass_fields__); import rlm.repl as _repl; assert callable(_repl.main); assert callable(_repl.emit); assert callable(_repl.host_request); assert callable(_repl.is_active); assert _repl.PROTOCOL_VERSION == 3; assert callable(rlm.emit); assert not hasattr(rlm, 'HOST_COMM_TARGET'); assert not hasattr(mcp, 'install_shutdown_hook')`;
const BOOTSTRAP_VERSION_FILE = ".bootstrap-version";
const BOOTSTRAP_LOCK_NAME = ".bootstrap.lock";
const BOOTSTRAP_LOCK_RETRY_MS = 250;
const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS = 30_000;
const BOOTSTRAP_LOCK_PROGRESS_AFTER_MS = 2_000;
const BOOTSTRAP_LOCK_TIMEOUT_MS = 15 * 60_000;
const KERNEL_VENVS_DIR_NAME = "kernel-venvs";
const LEGACY_KERNEL_VENV_DIR_NAME = "kernel-venv";
const KERNEL_VENV_LAST_USED_FILE = ".last-used";
const KERNEL_VENV_GC_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface InFlightEnsureKernelPython {
	key: string;
	promise: Promise<string>;
	// Aborts the shared work only once every attached caller has aborted.
	controller: AbortController;
	activeCallers: number;
}

let inFlightEnsureKernelPython: InFlightEnsureKernelPython | null = null;

export type KernelPythonSkill = PythonSkillRuntimeInfo;
export type KernelBootstrapProgressHandler = (message: string) => void;

export interface EnsureKernelPythonOptions {
	pythonSkills?: readonly KernelPythonSkill[];
	onProgress?: KernelBootstrapProgressHandler;
	// Stops waiting for another process's bootstrap lock. Installs already in
	// progress are not interrupted.
	signal?: AbortSignal;
}

interface BootstrapPythonSkill {
	importName: string;
	packagePath: string;
	pyprojectPath: string;
	pyprojectHash: string;
}

interface BootstrapVersion {
	schema: number;
	runtime?: string;
	snapshot?: string;
	extraUvArgs?: string[];
	pythonSkills?: BootstrapPythonSkill[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function fileContentHash(filePath: string): string {
	try {
		return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
	} catch {
		return "unreadable";
	}
}

function normalizePythonSkills(pythonSkills: readonly KernelPythonSkill[] | undefined): BootstrapPythonSkill[] {
	const byKey = new Map<string, BootstrapPythonSkill>();
	const addSkill = (skill: Pick<KernelPythonSkill, "importName" | "packagePath" | "pyprojectPath">): void => {
		const packagePath = path.resolve(skill.packagePath);
		const pyprojectPath = path.resolve(skill.pyprojectPath);
		const key = `${skill.importName}\0${packagePath}`;
		if (byKey.has(key)) {
			return;
		}
		const bootstrapSkill: BootstrapPythonSkill = {
			importName: skill.importName,
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		byKey.set(key, bootstrapSkill);
		for (const dependencyName of readPythonSkillDependencyNames(bootstrapSkill)) {
			const siblingDependency = resolveSiblingPythonSkillDependency(bootstrapSkill, dependencyName);
			if (siblingDependency) {
				addSkill(siblingDependency);
			}
		}
	};
	for (const skill of pythonSkills ?? []) {
		addSkill(skill);
	}
	return [...byKey.values()].sort((a, b) => {
		const packageCompare = a.packagePath.localeCompare(b.packagePath);
		if (packageCompare !== 0) return packageCompare;
		return a.importName.localeCompare(b.importName);
	});
}

function readTomlProjectSection(pyprojectPath: string): string | undefined {
	try {
		const text = readFileSync(pyprojectPath, "utf-8");
		const match = text.match(/^\s*\[project\]\s*$/m);
		if (!match || match.index === undefined) {
			return undefined;
		}
		const sectionStart = match.index + match[0].length;
		const rest = text.slice(sectionStart);
		const nextSection = rest.search(/^\s*\[/m);
		return nextSection >= 0 ? rest.slice(0, nextSection) : rest;
	} catch {
		return undefined;
	}
}

function readPythonSkillProjectName(skill: BootstrapPythonSkill): string {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	const name = projectSection?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
	return name?.trim() || skill.importName.replaceAll("_", "-");
}

function parseDependencyPackageName(dependency: string): string | undefined {
	const withoutMarker = dependency.split(";")[0]?.trim() ?? "";
	if (!withoutMarker) {
		return undefined;
	}
	const match = withoutMarker.match(/^([A-Za-z0-9_.-]+)/);
	return match?.[1]?.replaceAll("_", "-").toLowerCase();
}

function findTomlArrayEnd(text: string, startIndex: number): number {
	let inQuote: '"' | "'" | undefined;
	let escaped = false;
	for (let index = startIndex; index < text.length; index++) {
		const char = text[index];
		if (inQuote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === inQuote) {
				inQuote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}
		if (char === "]") {
			return index;
		}
	}
	return -1;
}

function readPythonSkillDependencyNames(skill: BootstrapPythonSkill): Set<string> {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	if (!projectSection) {
		return new Set();
	}
	const dependenciesStart = projectSection.search(/^\s*dependencies\s*=\s*\[/m);
	if (dependenciesStart < 0) {
		return new Set();
	}
	const arrayStart = projectSection.indexOf("[", dependenciesStart);
	if (arrayStart < 0) {
		return new Set();
	}
	const arrayEnd = findTomlArrayEnd(projectSection, arrayStart + 1);
	if (arrayEnd < 0) {
		return new Set();
	}
	const dependenciesArray = projectSection.slice(arrayStart, arrayEnd + 1);
	const dependencies = new Set<string>();
	const dependencyPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
	for (const match of dependenciesArray.matchAll(dependencyPattern)) {
		const dependency = (match[1] ?? match[2] ?? "").replaceAll('\\"', '"').replaceAll("\\'", "'");
		const name = parseDependencyPackageName(dependency);
		if (name) {
			dependencies.add(name);
		}
	}
	return dependencies;
}

function resolveSiblingPythonSkillDependency(
	skill: BootstrapPythonSkill,
	dependencyName: string,
): BootstrapPythonSkill | undefined {
	const siblingsDir = path.dirname(skill.packagePath);
	for (const entry of readdirSync(siblingsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const packagePath = path.join(siblingsDir, entry.name);
		const pyprojectPath = path.join(packagePath, "pyproject.toml");
		if (!existsSync(pyprojectPath)) {
			continue;
		}
		const dependency: BootstrapPythonSkill = {
			importName: entry.name.replaceAll("-", "_"),
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		if (readPythonSkillProjectName(dependency).replaceAll("_", "-").toLowerCase() === dependencyName) {
			return dependency;
		}
	}
	return undefined;
}

function sortPythonSkillsForInstall(pythonSkills: readonly BootstrapPythonSkill[]): BootstrapPythonSkill[] {
	const byProjectName = new Map<string, BootstrapPythonSkill>();
	const originalIndex = new Map<BootstrapPythonSkill, number>();
	for (const [index, skill] of pythonSkills.entries()) {
		originalIndex.set(skill, index);
		byProjectName.set(readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill);
	}

	const dependenciesBySkill = new Map<BootstrapPythonSkill, BootstrapPythonSkill[]>();
	for (const skill of pythonSkills) {
		dependenciesBySkill.set(
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						byProjectName.get(dependencyName) ?? resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		);
	}

	const pending = new Set(pythonSkills);
	const sorted: BootstrapPythonSkill[] = [];
	while (pending.size > 0) {
		let progressed = false;
		for (const skill of [...pending].sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))) {
			const dependencies = dependenciesBySkill.get(skill) ?? [];
			if (dependencies.some((dependency) => pending.has(dependency))) {
				continue;
			}
			sorted.push(skill);
			pending.delete(skill);
			progressed = true;
		}
		if (!progressed) {
			// Cyclic local skill dependencies cannot be topologically ordered; keep a
			// deterministic order and let uv surface the packaging error if needed.
			sorted.push(...[...pending].sort((a, b) => a.packagePath.localeCompare(b.packagePath)));
			break;
		}
	}
	return sorted;
}

function formatPythonSkillInstallArgs(skill: BootstrapPythonSkill): string[] {
	return ["--editable", skill.packagePath];
}

function ensureKernelPythonKey(pythonSkills: readonly BootstrapPythonSkill[]): string {
	return [
		process.env.PRIME_AGENT_KERNEL_PYTHON ?? "",
		process.env.PRIME_AGENT_KERNEL_VENV ?? "",
		process.env.HOME ?? "",
		process.env.LOCALAPPDATA ?? "",
		process.env.XDG_DATA_HOME ?? "",
		JSON.stringify(pythonSkills),
	].join("\0");
}

// Venvs are addressed by runtime identity so that different prime-agent builds
// (a source checkout vs. an installed release, or two builds with different
// rlm sources) coexist under kernel-venvs/ instead of rebuilding one shared
// directory underneath each other's live kernels. A registry install has the
// constant identity RUNTIME_REQUIREMENT, so the installed prime-agent version is
// mixed into its segment to give every upgrade a fresh directory.
function kernelVenvIdentitySegment(runtimeIdentity: string): string {
	const hex = runtimeIdentity.startsWith("sha256:")
		? runtimeIdentity.slice("sha256:".length)
		: createHash("sha256").update(`${runtimeIdentity}\0${VERSION}`).digest("hex");
	return `${BOOTSTRAP_SCHEMA}-${hex.slice(0, 12)}`;
}

export function getKernelVenvsRoot(): string {
	return path.join(os.homedir(), ".prime", "agent", KERNEL_VENVS_DIR_NAME);
}

function getFallbackKernelVenvsRoot(): string {
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		const dataHome = localAppData ? path.resolve(localAppData) : path.join(os.homedir(), "AppData", "Local");
		return path.join(dataHome, "prime", "agent", KERNEL_VENVS_DIR_NAME);
	}
	const dataHome = process.env.XDG_DATA_HOME
		? path.resolve(expandHome(process.env.XDG_DATA_HOME))
		: path.join(os.homedir(), ".local", "share");
	return path.join(dataHome, "prime", "agent", KERNEL_VENVS_DIR_NAME);
}

// PRIME_AGENT_KERNEL_VENV is an exact path: it is not identity-addressed and is
// rebuilt in place when its recorded identity no longer matches.
export function getKernelVenvDir(runtimeIdentity: string): string {
	const override = process.env.PRIME_AGENT_KERNEL_VENV;
	if (override) return path.resolve(expandHome(override));
	return path.join(getKernelVenvsRoot(), kernelVenvIdentitySegment(runtimeIdentity));
}

export function resolveKernelVenvDirSync(): string {
	return getKernelVenvDir(resolveRuntimeIdentitySync());
}

export function kernelVenvPython(venv: string): string {
	return process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

interface ResolvedKernelVenv {
	venv: string;
	// The kernel-venvs/ root this venv lives in; undefined for the exact-path override.
	root?: string;
}

async function resolveWritableKernelVenvDir(runtimeIdentity: string): Promise<ResolvedKernelVenv> {
	const primary = getKernelVenvDir(runtimeIdentity);
	if (process.env.PRIME_AGENT_KERNEL_VENV) {
		try {
			await mkdir(path.dirname(primary), { recursive: true });
			return { venv: primary };
		} catch (error) {
			throw new Error(`couldn't create kernel venv parent directory for ${primary}: ${errorMessage(error)}`);
		}
	}

	const segment = kernelVenvIdentitySegment(runtimeIdentity);
	const primaryRoot = getKernelVenvsRoot();
	try {
		await mkdir(primaryRoot, { recursive: true });
		return { venv: path.join(primaryRoot, segment), root: primaryRoot };
	} catch {
		const fallbackRoot = getFallbackKernelVenvsRoot();
		try {
			await mkdir(fallbackRoot, { recursive: true });
			return { venv: path.join(fallbackRoot, segment), root: fallbackRoot };
		} catch (fallbackError) {
			throw new Error(
				`couldn't create kernel venv directory at ${primary} or ${path.join(fallbackRoot, segment)}; set PRIME_AGENT_KERNEL_PYTHON to a python with a current prime-agent-runtime installed. ${errorMessage(fallbackError)}`,
			);
		}
	}
}

async function touchKernelVenvLastUsed(venv: string): Promise<void> {
	try {
		await writeFile(path.join(venv, KERNEL_VENV_LAST_USED_FILE), `${new Date().toISOString()}\n`, "utf8");
	} catch {
		// Best-effort marker; a missing marker only delays garbage collection.
	}
}

async function bootstrapLockIsHeld(venv: string): Promise<boolean> {
	const lockDir = bootstrapLockDir(venv);
	if (!(await exists(lockDir))) return false;
	return !(await bootstrapLockIsStale(lockDir));
}

async function collectStaleKernelVenv(venv: string, now: number): Promise<void> {
	if (await bootstrapLockIsHeld(venv)) return;
	const marker = path.join(venv, KERNEL_VENV_LAST_USED_FILE);
	let markerStat: Awaited<ReturnType<typeof stat>>;
	try {
		markerStat = await stat(marker);
	} catch {
		// No marker yet (built by an older prime-agent, or never used since this
		// marker was introduced): start the clock now instead of deleting.
		await touchKernelVenvLastUsed(venv);
		return;
	}
	if (now - markerStat.mtimeMs <= KERNEL_VENV_GC_AGE_MS) return;
	await rm(venv, { recursive: true, force: true });
}

// Removes sibling venvs of other runtime identities that have not been used for a
// week and are not being bootstrapped. A long-lived kernel still running from such
// a venv is not detectable from here; the age threshold is the compromise.
async function collectStaleKernelVenvs(root: string, currentVenv: string): Promise<void> {
	const now = Date.now();
	const candidates: string[] = [];
	try {
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.endsWith(BOOTSTRAP_LOCK_NAME)) continue;
			const venv = path.join(root, entry.name);
			if (venv === currentVenv) continue;
			candidates.push(venv);
		}
	} catch {
		return;
	}
	const legacyVenv = path.join(path.dirname(root), LEGACY_KERNEL_VENV_DIR_NAME);
	if (await exists(legacyVenv)) candidates.push(legacyVenv);
	for (const venv of candidates) {
		await collectStaleKernelVenv(venv, now).catch(() => undefined);
	}
}

function run(command: string, args: string[], options: { stdio?: "ignore" | "inherit" } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: process.env,
			stdio: options.stdio ?? "ignore",
			windowsHide: true,
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${reason}`));
		});
	});
}

async function pythonImports(python: string, moduleName: string): Promise<boolean> {
	try {
		await run(python, ["-c", `import ${moduleName}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function hasPrimeAgentRuntime(python: string): Promise<boolean> {
	try {
		await run(python, ["-c", RUNTIME_READY_CHECK], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function missingRlmExtraImportLabels(python: string): Promise<string[]> {
	const missing: string[] = [];
	for (const pkg of DEFAULT_RLM_EXTRA_PACKAGES) {
		if (!(await pythonImports(python, pkg.importName))) {
			missing.push(pkg.promptLabel);
		}
	}
	return missing;
}

async function missingPythonSkillImportLabels(
	python: string,
	pythonSkills: readonly KernelPythonSkill[],
): Promise<string[]> {
	const missing: string[] = [];
	for (const skill of pythonSkills) {
		if (!(await pythonImports(python, skill.importName))) {
			missing.push(`${skill.name} (${skill.importName})`);
		}
	}
	return missing;
}

function reportProgress(options: EnsureKernelPythonOptions, message: string): void {
	if (options.onProgress) {
		options.onProgress(message);
		return;
	}
	process.stderr.write(`${message}\n`);
}

function bootstrapLockDir(venv: string): string {
	return path.join(path.dirname(venv), `${path.basename(venv)}${BOOTSTRAP_LOCK_NAME}`);
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error, "EPERM");
	}
}

interface BootstrapLockOwner {
	pid: number;
	startId?: string;
}

async function readLockOwner(lockDir: string): Promise<BootstrapLockOwner | null> {
	try {
		const raw = await readFile(path.join(lockDir, "pid"), "utf8");
		const pid = Number.parseInt(raw.trim(), 10);
		if (!Number.isInteger(pid) || pid <= 0) return null;
		const startId = await readFile(path.join(lockDir, "start-id"), "utf8")
			.then((value) => value.trim() || undefined)
			.catch(() => undefined);
		return { pid, startId };
	} catch {
		return null;
	}
}

async function lockMissingPidIsStale(lockDir: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockDir);
		return Date.now() - lockStat.mtimeMs > BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS;
	} catch {
		return false;
	}
}

// A lock is stale when its owner pid is dead, or when the pid is alive but was
// started at a different time than the recorded owner (pid reuse). An unreadable
// start id counts as alive, never as stale.
function lockOwnerIsStale(owner: BootstrapLockOwner): boolean {
	if (!processIsRunning(owner.pid)) return true;
	if (!owner.startId) return false;
	const currentStartId = getProcessStartId(owner.pid);
	return currentStartId !== undefined && currentStartId !== owner.startId;
}

async function bootstrapLockIsStale(lockDir: string): Promise<boolean> {
	const owner = await readLockOwner(lockDir);
	return owner === null ? await lockMissingPidIsStale(lockDir) : lockOwnerIsStale(owner);
}

function sameLockOwner(a: BootstrapLockOwner | null, b: BootstrapLockOwner | null): boolean {
	return a?.pid === b?.pid && a?.startId === b?.startId;
}

function createBootstrapLockAbortError(): Error {
	const error = new Error("Kernel bootstrap aborted while waiting for the bootstrap lock");
	error.name = "AbortError";
	return error;
}

async function acquireBootstrapLock(venv: string, options: EnsureKernelPythonOptions): Promise<() => Promise<void>> {
	const lockDir = bootstrapLockDir(venv);
	await mkdir(path.dirname(lockDir), { recursive: true });
	const signal = options.signal;
	const waitStartedAt = Date.now();
	let progressReported = false;
	// The start-id lookup spawns a subprocess on macOS and Windows, so an owner is
	// fully verified once and then only re-checked with a cheap liveness probe
	// until the owner file changes.
	let verifiedOwner: BootstrapLockOwner | null = null;

	for (;;) {
		try {
			await mkdir(lockDir);
			await writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
			const startId = getCurrentProcessStartId();
			if (startId) await writeFile(path.join(lockDir, "start-id"), `${startId}\n`, "utf8");
			return () => rm(lockDir, { recursive: true, force: true });
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) throw error;
		}

		const owner = await readLockOwner(lockDir);
		let stale: boolean;
		if (owner === null) {
			verifiedOwner = null;
			stale = await lockMissingPidIsStale(lockDir);
		} else if (verifiedOwner !== null && sameLockOwner(owner, verifiedOwner)) {
			stale = !processIsRunning(owner.pid);
		} else {
			stale = lockOwnerIsStale(owner);
			verifiedOwner = stale ? null : owner;
		}
		if (stale) {
			await rm(lockDir, { recursive: true, force: true });
			continue;
		}

		if (signal?.aborted) throw createBootstrapLockAbortError();
		const waited = Date.now() - waitStartedAt;
		if (waited > BOOTSTRAP_LOCK_TIMEOUT_MS) {
			throw new Error(
				`Timed out after ${Math.round(BOOTSTRAP_LOCK_TIMEOUT_MS / 60_000)} minutes waiting for another prime-agent ` +
					`(pid ${owner?.pid ?? "unknown"}) to finish Python kernel setup. If no setup is running, remove the lock directory ${lockDir} and retry.`,
			);
		}
		if (!progressReported && waited > BOOTSTRAP_LOCK_PROGRESS_AFTER_MS) {
			progressReported = true;
			reportProgress(options, "waiting for another prime-agent to finish Python kernel setup...");
		}
		try {
			await sleep(BOOTSTRAP_LOCK_RETRY_MS, undefined, { signal });
		} catch {
			throw createBootstrapLockAbortError();
		}
	}
}

async function findExecutable(name: string): Promise<string | null> {
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
	const pathValue = pathKey ? process.env[pathKey] : undefined;
	if (!pathValue) return null;
	const candidates =
		process.platform === "win32"
			? path.extname(name)
				? [name]
				: (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
						.split(";")
						.filter(Boolean)
						.map((extension) => `${name}${extension.toLowerCase()}`)
			: [name];
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		const searchDir = dir.startsWith('"') && dir.endsWith('"') ? dir.slice(1, -1) : dir;
		for (const candidate of candidates) {
			const fullPath = path.join(searchDir, candidate);
			if (await isExecutable(fullPath)) return fullPath;
		}
	}
	return null;
}

function uvInstallCommand(): string {
	return process.platform === "win32" ? UV_INSTALL_COMMAND_WINDOWS : UV_INSTALL_COMMAND_UNIX;
}

function localUvCandidates(): string[] {
	const executable = process.platform === "win32" ? "uv.exe" : "uv";
	const candidates = [path.join(os.homedir(), ".local", "bin", executable)];
	if (process.env.UV_INSTALL_DIR) {
		candidates.unshift(path.join(path.resolve(expandHome(process.env.UV_INSTALL_DIR)), executable));
	}
	return candidates;
}

async function ensureUv(options: EnsureKernelPythonOptions): Promise<string> {
	const fromPath = await findExecutable("uv");
	if (fromPath) return fromPath;

	for (const localUv of localUvCandidates()) {
		if (await isExecutable(localUv)) return localUv;
	}

	const shouldInstallUv =
		process.env.PRIME_AGENT_INSTALL_UV === "1" || (!options.onProgress && (await confirmUvInstall()));
	if (!shouldInstallUv) {
		throw new Error(
			`uv is required to set up the Python kernel. Install uv yourself: ${uvInstallCommand()}, ` +
				"or set PRIME_AGENT_INSTALL_UV=1 to let prime-agent run that installer.",
		);
	}

	reportProgress(options, "› installing uv (one-time)…");
	try {
		if (process.platform === "win32") {
			const powershell = (await findExecutable("pwsh")) ?? (await findExecutable("powershell"));
			if (!powershell) {
				throw new Error("PowerShell was not found on PATH");
			}
			await run(
				powershell,
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-Command",
					UV_INSTALL_COMMAND_WINDOWS,
				],
				{ stdio: options.onProgress ? "ignore" : "inherit" },
			);
		} else {
			await run("sh", ["-c", UV_INSTALL_COMMAND_UNIX], {
				stdio: options.onProgress ? "ignore" : "inherit",
			});
		}
	} catch (error) {
		throw new Error(
			`couldn't install uv from astral.sh; install it yourself: ${uvInstallCommand()}, then re-run prime-agent. ${errorMessage(error)}`,
		);
	}

	for (const localUv of localUvCandidates()) {
		if (await isExecutable(localUv)) return localUv;
	}
	const installedFromPath = await findExecutable("uv");
	if (installedFromPath) return installedFromPath;
	throw new Error(`uv install completed but ${process.platform === "win32" ? "uv.exe" : "uv"} was not found`);
}

async function confirmUvInstall(): Promise<boolean> {
	if (process.env.PRIME_AGENT_INSTALL_UV === "0") return false;
	if (!stdin.isTTY || !stderr.isTTY) return false;

	const rl = createInterface({ input: stdin, output: stderr });
	try {
		const answer = (await rl.question("Prime Agent needs uv to set up Python. Install uv from astral.sh now? [Y/n] "))
			.trim()
			.toLowerCase();
		return answer !== "n" && answer !== "no";
	} finally {
		rl.close();
	}
}

async function readBootstrapVersion(venv: string): Promise<BootstrapVersion | null> {
	try {
		const raw = await readFile(path.join(venv, BOOTSTRAP_VERSION_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.schema !== "number") return null;
		const extraUvArgs =
			Array.isArray(parsed.extraUvArgs) &&
			parsed.extraUvArgs.every((v: unknown): v is string => typeof v === "string")
				? (parsed.extraUvArgs as string[])
				: undefined;
		let pythonSkills: BootstrapPythonSkill[] | undefined;
		if (Array.isArray(parsed.pythonSkills)) {
			if (
				!parsed.pythonSkills.every((v: unknown): v is BootstrapPythonSkill => {
					if (!isRecord(v)) return false;
					return (
						typeof v.importName === "string" &&
						typeof v.packagePath === "string" &&
						typeof v.pyprojectPath === "string" &&
						typeof v.pyprojectHash === "string"
					);
				})
			) {
				return null;
			}
			pythonSkills = parsed.pythonSkills as BootstrapPythonSkill[];
		}
		return {
			schema: parsed.schema,
			runtime: typeof parsed.runtime === "string" ? parsed.runtime : undefined,
			snapshot: typeof parsed.snapshot === "string" ? parsed.snapshot : undefined,
			extraUvArgs,
			pythonSkills,
		};
	} catch {
		return null;
	}
}

function extraUvArgsMatch(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function pythonSkillsByImportName(
	pythonSkills: readonly BootstrapPythonSkill[] | undefined,
): Map<string, BootstrapPythonSkill> {
	return new Map((pythonSkills ?? []).map((skill) => [skill.importName, skill]));
}

function pythonSkillRecorded(
	recorded: ReadonlyMap<string, BootstrapPythonSkill>,
	skill: BootstrapPythonSkill,
): boolean {
	const entry = recorded.get(skill.importName);
	return (
		entry !== undefined &&
		entry.packagePath === skill.packagePath &&
		entry.pyprojectPath === skill.pyprojectPath &&
		entry.pyprojectHash === skill.pyprojectHash
	);
}

// The manifest is keyed by import name and may hold skills other sessions on this
// machine installed; a session only needs its own skills present with matching
// package path and pyproject hash. One import name resolves to one editable
// install, so a different package path for a recorded name is a mismatch.
function pythonSkillsMatch(
	recorded: readonly BootstrapPythonSkill[] | undefined,
	requested: readonly BootstrapPythonSkill[],
): boolean {
	const byImportName = pythonSkillsByImportName(recorded);
	return requested.every((skill) => pythonSkillRecorded(byImportName, skill));
}

function sortPythonSkillsForManifest(pythonSkills: Iterable<BootstrapPythonSkill>): BootstrapPythonSkill[] {
	return [...pythonSkills].sort((a, b) => {
		const packageCompare = a.packagePath.localeCompare(b.packagePath);
		if (packageCompare !== 0) return packageCompare;
		return a.importName.localeCompare(b.importName);
	});
}

function bootstrapVersionCurrent(
	version: BootstrapVersion | null,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): boolean {
	return (
		version !== null &&
		bootstrapBaseVersionCurrent(version, runtimeIdentity) &&
		pythonSkillsMatch(version.pythonSkills, pythonSkills)
	);
}

function bootstrapBaseVersionCurrent(version: BootstrapVersion | null, runtimeIdentity: string): boolean {
	return (
		version?.schema === BOOTSTRAP_SCHEMA &&
		version.runtime === runtimeIdentity &&
		version.snapshot === STATE_SNAPSHOT_REQUIREMENT &&
		extraUvArgsMatch(version.extraUvArgs, DEFAULT_RLM_EXTRA_UV_ARGS)
	);
}

async function writeBootstrapVersion(
	venv: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<void> {
	const version: BootstrapVersion = {
		schema: BOOTSTRAP_SCHEMA,
		runtime: runtimeIdentity,
		snapshot: STATE_SNAPSHOT_REQUIREMENT,
		extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
		pythonSkills: [...pythonSkills],
	};
	await writeFile(path.join(venv, BOOTSTRAP_VERSION_FILE), `${JSON.stringify(version)}\n`, "utf8");
}

function runtimeCandidateDirs(): string[] {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	// dist/prime-agent-runtime is listed first deliberately: it is the only path stable
	// across every shipped layout (dist/, dist/bundle/, bun), where import.meta.url-relative
	// resolution breaks. `npm run build` rebuilds it from live source (copy-assets does
	// rm -rf + cp), so the staleness hash still refreshes on every build. The relative
	// paths below cover running from source (tsx) where dist/ hasn't been built.
	return [
		path.join(getPackageDir(), "dist", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "..", "..", "..", "prime-agent-runtime"),
	];
}

function resolveRuntimeSourceDir(): string | null {
	for (const candidate of runtimeCandidateDirs()) {
		if (existsSync(path.join(candidate, "pyproject.toml"))) {
			return candidate;
		}
	}
	return null;
}

// Identity of the runtime to be installed. For a local source checkout this is a
// content hash of every rlm/*.py file plus pyproject.toml, so any runtime code or
// dependency change invalidates an existing venv automatically. Falls back to the
// bare package name when the runtime resolves to a registry install (no local source).
// Synchronous so module-load-time callers (test guards) can resolve the venv path.
export function resolveRuntimeIdentitySync(): string {
	const sourceDir = resolveRuntimeSourceDir();
	if (!sourceDir) return RUNTIME_REQUIREMENT;
	return hashRuntimeSource(sourceDir);
}

export async function resolveRuntimeIdentity(): Promise<string> {
	return resolveRuntimeIdentitySync();
}

// Throws if the local source can't be read. A failure here must surface rather than
// fall back to RUNTIME_REQUIREMENT: that constant is the registry-install identity, and
// recording it for a local checkout would permanently mask later source changes.
function hashRuntimeSource(sourceDir: string): string {
	const rlmDir = path.join(sourceDir, "src", "rlm");
	const files: string[] = [path.join(sourceDir, "pyproject.toml")];
	function collect(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				collect(full);
			} else if (entry.isFile() && entry.name.endsWith(".py")) {
				files.push(full);
			}
		}
	}
	collect(rlmDir);
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(sourceDir, file));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

async function bootstrapVenv(
	venv: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	await mkdir(path.dirname(venv), { recursive: true });
	const uv = await ensureUv(options);
	const python = kernelVenvPython(venv);
	const sourceDir = resolveRuntimeSourceDir();
	const runtimeRequirement = sourceDir ?? RUNTIME_REQUIREMENT;
	const runtimeIdentity = resolveRuntimeIdentitySync();

	await run(uv, ["python", "install", PYTHON_VERSION]);
	await run(uv, ["venv", venv, "--python", PYTHON_VERSION, "--seed"]);
	await run(uv, [
		"pip",
		"install",
		"--python",
		python,
		runtimeRequirement,
		STATE_SNAPSHOT_REQUIREMENT,
		...DEFAULT_RLM_EXTRA_UV_ARGS,
	]);
	await syncPythonSkills(uv, venv, python, runtimeIdentity, pythonSkills, options);
}

async function resolvePythonOverride(override: string): Promise<string> {
	const expanded = expandHome(override);
	if (path.isAbsolute(expanded) || expanded.includes("/") || expanded.includes("\\")) {
		return path.resolve(expanded);
	}
	return (await findExecutable(expanded)) ?? expanded;
}

async function syncPythonSkills(
	uv: string,
	venv: string,
	python: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	const version = await readBootstrapVersion(venv);
	const installedPythonSkills: BootstrapPythonSkill[] = [];
	const currentPythonSkills = pythonSkillsByImportName(version?.pythonSkills);
	const pythonSkillsByProjectName = new Map(
		pythonSkills.map((skill) => [readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill]),
	);
	const dependenciesBySkill = new Map(
		pythonSkills.map((skill) => [
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						pythonSkillsByProjectName.get(dependencyName) ??
						resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		]),
	);

	for (const skill of sortPythonSkillsForInstall(pythonSkills)) {
		if (pythonSkillRecorded(currentPythonSkills, skill)) {
			installedPythonSkills.push(skill);
			continue;
		}

		const localDependencies = dependenciesBySkill.get(skill) ?? [];
		const localDependencyArgs = localDependencies
			.filter((dependency) => {
				const installedThisSync = installedPythonSkills.some(
					(installed) =>
						installed.importName === dependency.importName &&
						installed.packagePath === dependency.packagePath &&
						installed.pyprojectPath === dependency.pyprojectPath &&
						installed.pyprojectHash === dependency.pyprojectHash,
				);
				return !(installedThisSync || pythonSkillRecorded(currentPythonSkills, dependency));
			})
			.flatMap(formatPythonSkillInstallArgs);

		try {
			await run(uv, [
				"pip",
				"install",
				"--python",
				python,
				...formatPythonSkillInstallArgs(skill),
				...localDependencyArgs,
			]);
			installedPythonSkills.push(
				skill,
				...localDependencies.filter((dependency) => !installedPythonSkills.includes(dependency)),
			);
		} catch (error) {
			reportProgress(
				options,
				`Warning: Python skill ${skill.importName} failed to install and will be unavailable: ${errorMessage(error)}`,
			);
		}
	}
	// Merge into the recorded manifest: skills installed by other sessions stay
	// recorded (nothing is ever uninstalled), and a reinstall for an import name
	// replaces that name's entry.
	const manifest = new Map(currentPythonSkills);
	for (const skill of installedPythonSkills) {
		manifest.set(skill.importName, skill);
	}
	await writeBootstrapVersion(venv, runtimeIdentity, sortPythonSkillsForManifest(manifest.values()));
}

async function kernelBaseReady(python: string, venv: string, runtimeIdentity: string): Promise<boolean> {
	return (
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapBaseVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity)
	);
}

async function kernelReady(
	python: string,
	venv: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<boolean> {
	return (
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity, pythonSkills)
	);
}

function formatBootstrapFailure(error: unknown): Error {
	return new Error(
		`Failed to set up the Python kernel runtime. ${errorMessage(error)}\n` +
			"First-time setup needs internet to install uv, Python, prime-agent-runtime, and default Python packages; once set up, prime-agent runs offline. " +
			"Set PRIME_AGENT_KERNEL_PYTHON to a Python with a current prime-agent-runtime and default Python packages installed to skip auto-bootstrap.",
	);
}

async function ensureKernelPythonUncached(
	options: EnsureKernelPythonOptions,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<string> {
	const override = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (override) {
		const python = await resolvePythonOverride(override);
		const missing: string[] = [];
		if (!(await hasPrimeAgentRuntime(python))) {
			missing.push(
				"a current prime-agent-runtime with callable rlm.run, rlm.host_request, and explicit harness CRUD methods",
			);
		}
		if (missing.length === 0) {
			const missingExtraImports = await missingRlmExtraImportLabels(python);
			if (missingExtraImports.length > 0) {
				missing.push(`default Python packages (${missingExtraImports.join(", ")})`);
			}
		}
		if (missing.length === 0 && pythonSkills.length > 0) {
			const missingPythonSkills = await missingPythonSkillImportLabels(python, options.pythonSkills ?? []);
			if (missingPythonSkills.length > 0) {
				reportProgress(
					options,
					`Warning: Python skills unavailable in PRIME_AGENT_KERNEL_PYTHON and will be disabled: ${missingPythonSkills.join(", ")}`,
				);
			}
		}
		if (missing.length === 0) return python;
		throw new Error(`PRIME_AGENT_KERNEL_PYTHON points to a Python missing ${missing.join(" and ")}: ${python}`);
	}

	const runtimeIdentity = resolveRuntimeIdentitySync();
	const { venv, root } = await resolveWritableKernelVenvDir(runtimeIdentity);
	const python = kernelVenvPython(venv);
	const finish = async (): Promise<string> => {
		await touchKernelVenvLastUsed(venv);
		if (root) await collectStaleKernelVenvs(root, venv).catch(() => undefined);
		return python;
	};
	if (await kernelReady(python, venv, runtimeIdentity, pythonSkills)) return finish();

	const releaseLock = await acquireBootstrapLock(venv, options);
	try {
		if (await kernelReady(python, venv, runtimeIdentity, pythonSkills)) return finish();
		if (await kernelBaseReady(python, venv, runtimeIdentity)) {
			await syncPythonSkills(await ensureUv(options), venv, python, runtimeIdentity, pythonSkills, options);
			return finish();
		}

		// Reaching here with an existing venv means it is broken or half-built (or,
		// for the PRIME_AGENT_KERNEL_VENV override, recorded for another identity).
		// An identity-addressed dir is only ever used by processes with this same
		// identity, and they all serialize on this lock, so rebuilding it in place
		// is safe; a different identity never lands here because it resolves to its
		// own sibling directory.
		const hadVenv = existsSync(venv);
		reportProgress(options, "› setting up python kernel (one-time, ~30s)…");
		if (hadVenv) {
			reportProgress(options, "rebuilding kernel venv");
			await rm(venv, { recursive: true, force: true });
		}

		await bootstrapVenv(venv, pythonSkills, options);
	} catch (error) {
		throw formatBootstrapFailure(error);
	} finally {
		await releaseLock().catch(() => undefined);
	}

	reportProgress(options, "✓ ready");
	return finish();
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(createBootstrapLockAbortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(createBootstrapLockAbortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

// Attaches a caller to the shared in-flight work: the caller stops waiting when
// its own signal aborts, while the shared work is only aborted once no attached
// caller remains.
function attachEnsureCaller(inFlight: InFlightEnsureKernelPython, signal: AbortSignal | undefined): Promise<string> {
	inFlight.activeCallers += 1;
	const detach = () => {
		inFlight.activeCallers -= 1;
		if (inFlight.activeCallers === 0) inFlight.controller.abort();
	};
	if (signal) signal.addEventListener("abort", detach, { once: true });
	return raceWithAbort(inFlight.promise, signal).finally(() => {
		signal?.removeEventListener("abort", detach);
	});
}

export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
	if (options.signal?.aborted) return Promise.reject(createBootstrapLockAbortError());
	const pythonSkills = normalizePythonSkills(options.pythonSkills);
	const key = ensureKernelPythonKey(pythonSkills);
	if (inFlightEnsureKernelPython?.key === key && !inFlightEnsureKernelPython.controller.signal.aborted) {
		return attachEnsureCaller(inFlightEnsureKernelPython, options.signal);
	}

	const controller = new AbortController();
	const promise = ensureKernelPythonUncached({ ...options, signal: controller.signal }, pythonSkills).finally(() => {
		if (inFlightEnsureKernelPython?.promise === promise) inFlightEnsureKernelPython = null;
	});
	const inFlight: InFlightEnsureKernelPython = { key, promise, controller, activeCallers: 0 };
	inFlightEnsureKernelPython = inFlight;
	return attachEnsureCaller(inFlight, options.signal);
}
