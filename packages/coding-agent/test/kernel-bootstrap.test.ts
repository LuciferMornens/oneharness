import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	getKernelVenvDir,
	getKernelVenvsRoot,
	type KernelPythonSkill,
	kernelVenvPython,
	resolveRuntimeIdentity,
} from "../src/core/kernel/bootstrap.js";
import { getCurrentProcessStartId } from "../src/core/session-lease.js";

const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const kernelSyncChildPath = resolve(__dirname, "helpers/kernel-sync-child.ts");

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let runtimeIdentity = "";

function pyprojectHash(pyprojectPath: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(pyprojectPath)).digest("hex")}`;
}

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

function writeBootstrapVersion(venv: string, pythonSkills: readonly KernelPythonSkill[] = []): void {
	writeFileSync(
		join(venv, ".bootstrap-version"),
		`${JSON.stringify({
			schema: 9,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: pythonSkills.map((skill) => ({
				importName: skill.importName,
				packagePath: skill.packagePath,
				pyprojectPath: skill.pyprojectPath,
				pyprojectHash: pyprojectHash(skill.pyprojectPath),
			})),
		})}\n`,
	);
}

function createPythonSkill(name = "web-search", skillsDir = join(tempDir, "skills")): KernelPythonSkill {
	const packagePath = join(skillsDir, name);
	const importName = name.replaceAll("-", "_");
	const pyprojectPath = join(packagePath, "pyproject.toml");
	mkdirSync(join(packagePath, "src", importName), { recursive: true });
	writeFileSync(
		pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
`,
	);
	writeFileSync(join(packagePath, "src", importName, "__init__.py"), "async def run():\n    return 'ok'\n");
	return {
		name,
		importName,
		packagePath,
		pyprojectPath,
	};
}

function createPythonSkillWithDependency(name: string, dependencyName: string): KernelPythonSkill {
	const skill = createPythonSkill(name);
	writeFileSync(
		skill.pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
dependencies = ["${dependencyName}"]
`,
	);
	return skill;
}

function writeFakePython(
	filePath: string,
	importableModules: readonly string[],
	deniedProbes: readonly string[] = [],
): void {
	const cases = importableModules.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`).join("\n");
	const denyCases = deniedProbes.map((probe) => `    *"${probe}"*) exit 1 ;;`).join("\n");
	const runtimeCase =
		importableModules.includes("rlm") && !deniedProbes.includes("_harness_methods")
			? '    *"_harness_methods"*) exit 0 ;;'
			: "";
	writeExecutable(
		filePath,
		[
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			cases,
			denyCases,
			runtimeCase,
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
}

function installFakeUv(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	const extraImportCases = DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`);
	process.env.UV_LOG = logPath;
	process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
	writeExecutable(
		join(binDir, "uv"),
		[
			"#!/bin/sh",
			"set -e",
			'printf "%s\\n" "$*" >> "$UV_LOG"',
			'if [ "$1" = "python" ]; then',
			"  exit 0",
			"fi",
			'if [ "$1" = "venv" ]; then',
			'  venv="$2"',
			'  mkdir -p "$venv/bin"',
			"  cat > \"$venv/bin/python\" <<'PY'",
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			'    "import rlm") exit 0 ;;',
			...extraImportCases,
			'    *"_harness_methods"*) exit 0 ;;',
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"PY",
			'  chmod +x "$venv/bin/python"',
			"  exit 0",
			"fi",
			'if [ "$1" = "pip" ]; then',
			'  marker_file=""',
			'  seen_editable=""',
			'  prev=""',
			'  for arg in "$@"; do',
			'    if [ "$prev" = "--python" ]; then',
			'      marker_file="$(dirname "$arg")/../.bootstrap-version"',
			"    fi",
			'    if [ "$arg" = "--editable" ]; then',
			"      seen_editable=1",
			"    fi",
			'    if [ "$UV_HANG_ARG" != "" ] && [ "$arg" = "$UV_HANG_ARG" ]; then',
			"      sleep 30",
			"    fi",
			'    if [ "$UV_FAIL_ARG" != "" ] && [ "$arg" = "$UV_FAIL_ARG" ]; then',
			"      exit 1",
			"    fi",
			'    prev="$arg"',
			"  done",
			'  if [ "$seen_editable" != "" ] && [ "$marker_file" != "" ]; then',
			'    if [ -f "$marker_file" ]; then',
			'      printf "MARKER %s\n" "$(cat "$marker_file")" >> "$UV_LOG"',
			"    else",
			'      printf "MARKER missing\n" >> "$UV_LOG"',
			"    fi",
			"  fi",
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
	return logPath;
}

describe("kernel bootstrap", () => {
	beforeEach(async () => {
		runtimeIdentity = await resolveRuntimeIdentity();
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-bootstrap-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		// Mutate rather than replace process.env: a replaced object is not the real
		// environment, so later HOME assignments would not reach os.homedir().
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("returns the configured kernel venv directory", () => {
		const venv = join(tempDir, "custom-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		expect(getKernelVenvDir(runtimeIdentity)).toBe(venv);
		expect(getKernelVenvDir("sha256:other")).toBe(venv);
	});

	it("addresses default kernel venvs by runtime identity", () => {
		const root = join(tempDir, ".prime", "agent", "kernel-venvs");
		const sourceA = getKernelVenvDir(`sha256:${"a".repeat(64)}`);
		const sourceB = getKernelVenvDir(`sha256:${"b".repeat(64)}`);
		const registry = getKernelVenvDir("prime-agent-runtime");

		expect(getKernelVenvsRoot()).toBe(root);
		expect(sourceA).toBe(join(root, `9-${"a".repeat(12)}`));
		expect(sourceB).toBe(join(root, `9-${"b".repeat(12)}`));
		expect(registry).toMatch(/[/\\]9-[0-9a-f]{12}$/);
		expect(new Set([sourceA, sourceB, registry]).size).toBe(3);
	});

	it("bootstraps the default venv under kernel-venvs without touching other identities", async () => {
		const logPath = installFakeUv();
		const venv = getKernelVenvDir(runtimeIdentity);
		const otherVenv = join(getKernelVenvsRoot(), "9-000000000000");
		mkdirSync(join(otherVenv, "bin"), { recursive: true });
		writeFileSync(join(otherVenv, ".last-used"), "recent\n");

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11`);
		expect(existsSync(join(otherVenv, "bin"))).toBe(true);
		expect(existsSync(join(venv, ".last-used"))).toBe(true);
	});

	it("garbage collects stale unlocked sibling venvs and the legacy venv", async () => {
		const root = getKernelVenvsRoot();
		const venv = getKernelVenvDir(runtimeIdentity);
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv);

		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		const makeSibling = (name: string, lastUsed: Date | undefined): string => {
			const dir = join(root, name);
			mkdirSync(join(dir, "bin"), { recursive: true });
			if (lastUsed) {
				writeFileSync(join(dir, ".last-used"), `${lastUsed.toISOString()}\n`);
				utimesSync(join(dir, ".last-used"), lastUsed, lastUsed);
			}
			return dir;
		};
		const staleUnlocked = makeSibling("9-aaaaaaaaaaaa", eightDaysAgo);
		const staleLocked = makeSibling("9-bbbbbbbbbbbb", eightDaysAgo);
		mkdirSync(`${staleLocked}.bootstrap.lock`);
		writeFileSync(join(`${staleLocked}.bootstrap.lock`, "pid"), `${process.pid}\n`);
		const recent = makeSibling("9-cccccccccccc", new Date());
		const markerless = makeSibling("9-dddddddddddd", undefined);
		const legacy = join(tempDir, ".prime", "agent", "kernel-venv");
		mkdirSync(join(legacy, "bin"), { recursive: true });
		writeFileSync(join(legacy, ".last-used"), `${eightDaysAgo.toISOString()}\n`);
		utimesSync(join(legacy, ".last-used"), eightDaysAgo, eightDaysAgo);

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(existsSync(staleUnlocked)).toBe(false);
		expect(existsSync(legacy)).toBe(false);
		expect(existsSync(join(staleLocked, "bin"))).toBe(true);
		expect(existsSync(join(recent, "bin"))).toBe(true);
		expect(existsSync(join(markerless, "bin"))).toBe(true);
		expect(existsSync(join(markerless, ".last-used"))).toBe(true);
		expect(existsSync(join(venv, "bin"))).toBe(true);
	});

	it("leaves a marker-less legacy venv in place and starts its clock", async () => {
		const venv = getKernelVenvDir(runtimeIdentity);
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv);
		const legacy = join(tempDir, ".prime", "agent", "kernel-venv");
		mkdirSync(join(legacy, "bin"), { recursive: true });

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(existsSync(join(legacy, "bin"))).toBe(true);
		expect(existsSync(join(legacy, ".last-used"))).toBe(true);
	});

	it("keeps PRIME_AGENT_KERNEL_VENV as an exact path and skips sibling garbage collection", async () => {
		installFakeUv();
		const venv = join(tempDir, "custom", "venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		const stale = join(getKernelVenvsRoot(), "9-aaaaaaaaaaaa");
		mkdirSync(join(stale, "bin"), { recursive: true });
		writeFileSync(join(stale, ".last-used"), "old\n");
		utimesSync(join(stale, ".last-used"), eightDaysAgo, eightDaysAgo);

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		expect(existsSync(join(venv, ".bootstrap-version"))).toBe(true);
		expect(existsSync(join(stale, "bin"))).toBe(true);
	});

	it("bootstraps a missing venv with uv, the runtime, extras and editable Python skills", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("python install 3.11");
		expect(log).toContain(`venv ${venv} --python 3.11`);
		expect(log).not.toContain("--seed");
		expect(log).toContain("pip install --python");
		expect(log).not.toContain("ipykernel");
		expect(log).toContain("prime-agent-runtime");
		expect(log).toContain("dill");
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		for (const uvArg of DEFAULT_RLM_EXTRA_UV_ARGS) {
			expect(log).toContain(uvArg);
		}

		// The on-disk manifest is what every later warm-start decision reads.
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version).toEqual({
			schema: 9,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: [
				{
					importName: pythonSkill.importName,
					packagePath: pythonSkill.packagePath,
					pyprojectPath: pythonSkill.pyprojectPath,
					pyprojectHash: pyprojectHash(pythonSkill.pyprojectPath),
				},
			],
		});
		expect(version.runtime).toMatch(/^sha256:/);
	});

	it.each([
		{ name: "a sibling skill directory", packageName: undefined, dependency: "attach-image" },
		{
			name: "a sibling whose package and directory names differ",
			packageName: "prime-agent-skill-attach-image",
			dependency: "prime-agent-skill-attach-image",
		},
		{
			name: "a dependency declared with extras and a version bound",
			packageName: undefined,
			dependency: "attach-image[httpx]>4.0.0",
		},
	])("installs $name as an editable package", async ({ packageName, dependency }) => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("attach-image");
		if (packageName) {
			writeFileSync(dependencySkill.pyprojectPath, `[project]\nname = "${packageName}"\nversion = "0.1.0"\n`);
		}
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", dependency);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("preserves recorded Python skills when a no-skill bootstrap call reuses a warm venv", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		const pythonSkill = createPythonSkill();
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [pythonSkill]);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: pythonSkill.importName,
				packagePath: pythonSkill.packagePath,
				pyprojectPath: pythonSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(pythonSkill.pyprojectPath),
			},
		]);
	});

	it("keeps a skill-synced venv fast for real sessions after a no-skill bootstrap call", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(join(venv, "bin", "python"));
		const syncedLog = readFileSync(logPath, "utf8");

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));
		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(join(venv, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toBe(syncedLog);
	});

	it("writes the base marker before the first install and keeps a failed skill out of the record", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const installedSkill = createPythonSkill("agent-a");
		const brokenSkill = createPythonSkill("agent-b");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.UV_FAIL_ARG = brokenSkill.packagePath;

		await expect(ensureKernelPython({ pythonSkills: [installedSkill, brokenSkill] })).resolves.toBe(
			join(venv, "bin", "python"),
		);
		const markers = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("MARKER "))
			.map((probe) => probe.slice("MARKER ".length));
		expect(JSON.parse(markers[0]).pythonSkills).toEqual([]);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills.map((skill: { importName: string }) => skill.importName)).toEqual([
			installedSkill.importName,
		]);
	});

	it("accepts a warm venv whose manifest is a superset of the requested Python skills", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		const skillA = createPythonSkill("skill-a");
		const skillB = createPythonSkill("skill-b");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [skillB, skillA]);
		const manifestBefore = readFileSync(join(venv, ".bootstrap-version"), "utf8");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [skillA] })).resolves.toBe(python);

		expect(existsSync(logPath)).toBe(false);
		expect(readFileSync(join(venv, ".bootstrap-version"), "utf8")).toBe(manifestBefore);
	});

	it("installs only the missing Python skills into a warm venv and keeps recorded ones", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		const skillA = createPythonSkill("skill-a");
		const skillB = createPythonSkill("skill-b");
		const skillC = createPythonSkill("skill-c");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [skillA, skillC]);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [skillA, skillB] })).resolves.toBe(python);

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${skillB.packagePath}`);
		expect(log).not.toContain(`--editable ${skillA.packagePath}`);
		expect(log).not.toContain(`--editable ${skillC.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills.map((skill: { importName: string }) => skill.importName)).toEqual([
			"skill_a",
			"skill_b",
			"skill_c",
		]);
	});

	it("reinstalls a Python skill whose import name is recorded from a different package path", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		const globalSkill = createPythonSkill("skill-a", join(tempDir, "global-skills"));
		const projectSkill = createPythonSkill("skill-a", join(tempDir, "project-skills"));
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [globalSkill]);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [projectSkill] })).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`--editable ${projectSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: projectSkill.importName,
				packagePath: projectSkill.packagePath,
				pyprojectPath: projectSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(projectSkill.pyprojectPath),
			},
		]);
	});

	// test-policy: allow explicit-test-timeout -- bounds real killed tsx respawn and resume variance, not the assertion
	it("resumes a real killed mid-sync process without rebuilding the venv", { timeout: 60_000 }, async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		const staleSkill = createPythonSkill("agent-a");
		const recordedSkill = createPythonSkill("agent-b");
		const hangingSkill = createPythonSkill("agent-c");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [staleSkill, recordedSkill]);
		writeFileSync(staleSkill.pyprojectPath, `[project]\nname = "${staleSkill.name}"\nversion = "0.2.0"\n`);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const child = spawn(process.execPath, [tsxPath, kernelSyncChildPath], {
			env: {
				...process.env,
				KERNEL_SYNC_CHILD_SKILLS: JSON.stringify([staleSkill, recordedSkill, hangingSkill]),
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				UV_HANG_ARG: hangingSkill.packagePath,
			},
			stdio: "ignore",
			detached: true,
		});
		try {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				if (child.exitCode !== null || child.signalCode !== null) break;
				const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
				if (
					log.includes(`--editable ${staleSkill.packagePath}`) &&
					log.includes(`--editable ${hangingSkill.packagePath}`)
				) {
					break;
				}
				// test-policy: allow wall-clock-sleep -- polls the external fake-uv log appends; no in-process signal exists
				await sleep(50);
			}
		} finally {
			const pid = child.pid;
			if (pid !== undefined) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
			await new Promise((resolve) => child.once("exit", resolve));
		}
		const versionAtKill = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(versionAtKill.pythonSkills.map((skill: { importName: string }) => skill.importName)).toEqual([
			staleSkill.importName,
			recordedSkill.importName,
		]);
		expect(versionAtKill.pythonSkills[0].pyprojectHash).toBe(pyprojectHash(staleSkill.pyprojectPath));

		await expect(ensureKernelPython({ pythonSkills: [staleSkill, recordedSkill, hangingSkill] })).resolves.toBe(
			python,
		);

		const lines = readFileSync(logPath, "utf8").split("\n");
		expect(lines.some((line) => line.startsWith(`venv ${venv} `))).toBe(false);
		expect(lines.filter((line) => line.includes(`--editable ${staleSkill.packagePath}`))).toHaveLength(1);
		expect(lines.filter((line) => line.includes(`--editable ${recordedSkill.packagePath}`))).toHaveLength(0);
		expect(lines.filter((line) => line.includes(`--editable ${hangingSkill.packagePath}`))).toHaveLength(2);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills.map((skill: { importName: string }) => skill.importName)).toEqual([
			staleSkill.importName,
			recordedSkill.importName,
			hangingSkill.importName,
		]);
	});

	it("shares concurrent bootstrap work in one process", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(Promise.all([ensureKernelPython(), ensureKernelPython()])).resolves.toEqual([python, python]);

		const log = readFileSync(logPath, "utf8");
		expect(log.split("\n").filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
	});

	it.each([
		{
			name: "reuses a current warm venv without invoking uv",
			rebuilds: false,
			prepare: (venv: string, python: string) => {
				writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
				writeBootstrapVersion(venv);
			},
		},
		{
			name: "rebuilds when the recorded runtime hash no longer matches local source",
			rebuilds: true,
			prepare: (venv: string, python: string) => {
				writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
				writeFileSync(
					join(venv, ".bootstrap-version"),
					`${JSON.stringify({
						schema: 9,
						runtime: "sha256:stale",
						snapshot: "dill",
						extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
						pythonSkills: [],
					})}\n`,
				);
			},
		},
		{
			name: "rebuilds a legacy unhashed Python skill manifest",
			rebuilds: true,
			prepare: (venv: string, python: string) => {
				const pythonSkill = createPythonSkill();
				writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
				writeFileSync(
					join(venv, ".bootstrap-version"),
					`${JSON.stringify({
						schema: 4,
						runtime: "prime-agent-runtime",
						extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
						pythonSkills: [
							{
								importName: pythonSkill.importName,
								packagePath: pythonSkill.packagePath,
								pyprojectPath: pythonSkill.pyprojectPath,
							},
						],
					})}\n`,
				);
			},
		},
		{
			name: "rebuilds a venv whose rlm runtime is stale",
			rebuilds: true,
			prepare: (venv: string, python: string) => {
				// Imports rlm but fails the runtime-capability probe.
				writeFakePython(python, ["rlm"], ["_harness_methods"]);
				writeBootstrapVersion(venv);
			},
		},
		{
			name: "rebuilds a venv whose interpreter is missing entirely",
			rebuilds: true,
			prepare: (venv: string) => {
				writeBootstrapVersion(venv);
			},
		},
	])("$name", async ({ rebuilds, prepare }) => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		prepare(venv, python);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		// A warm venv that needs no work never runs uv, so the log may not exist at all.
		const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		expect(log.includes(`venv ${venv} --python 3.11`)).toBe(rebuilds);
		if (rebuilds) {
			expect(JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8")).runtime).toBe(runtimeIdentity);
		}
	});

	function writeBootstrapLock(venv: string, pid: number, startId?: string): string {
		const lockDir = `${venv}.bootstrap.lock`;
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(join(lockDir, "pid"), `${pid}\n`);
		if (startId) writeFileSync(join(lockDir, "start-id"), `${startId}\n`);
		return lockDir;
	}

	function exitedPid(): number {
		const child = spawnSync("sh", ["-c", "exit 0"]);
		if (!child.pid) throw new Error("could not spawn a short-lived process");
		return child.pid;
	}

	it("reclaims a bootstrap lock whose owner pid is dead", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = writeBootstrapLock(venv, exitedPid(), "proc:1");

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11`);
		expect(existsSync(lockDir)).toBe(false);
	});

	it("reclaims a bootstrap lock whose owner pid was reused by another process", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = writeBootstrapLock(venv, process.pid, "proc:0");

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11`);
		expect(existsSync(lockDir)).toBe(false);
	});

	it("waits for a live bootstrap lock and reports progress", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = writeBootstrapLock(venv, process.pid, getCurrentProcessStartId());
		const progress: string[] = [];
		const startedAt = Date.now();
		const holdMs = 2_600;
		const release = setTimeout(() => rmSync(lockDir, { recursive: true, force: true }), holdMs);

		try {
			await expect(ensureKernelPython({ onProgress: (message) => progress.push(message) })).resolves.toBe(
				join(venv, "bin", "python"),
			);
		} finally {
			clearTimeout(release);
		}

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(holdMs - 50);
		expect(progress).toContain("waiting for another prime-agent to finish Python kernel setup...");
		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11`);
	}, 10_000);

	it("records its own pid and start id in the bootstrap lock", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = `${venv}.bootstrap.lock`;
		let seen: { pid: string; startId: string } | undefined;
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await ensureKernelPython({
				onProgress: () => {
					if (!seen && existsSync(join(lockDir, "pid"))) {
						seen = {
							pid: readFileSync(join(lockDir, "pid"), "utf8").trim(),
							startId: readFileSync(join(lockDir, "start-id"), "utf8").trim(),
						};
					}
				},
			});
		} finally {
			stderrWrite.mockRestore();
		}

		expect(seen).toEqual({ pid: String(process.pid), startId: getCurrentProcessStartId() });
		expect(existsSync(lockDir)).toBe(false);
	});

	it("gives up on a live bootstrap lock after the wait bound and names the lock", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = writeBootstrapLock(venv, process.pid, getCurrentProcessStartId());
		// Let the first poll see real time, then jump the clock past the wait bound.
		const realNow = Date.now();
		const mockedAt = performance.now();
		const nowSpy = vi
			.spyOn(Date, "now")
			.mockImplementation(() => realNow + (performance.now() - mockedAt > 150 ? 16 * 60_000 : 0));

		try {
			await expect(ensureKernelPython()).rejects.toThrow(
				new RegExp(
					`Timed out after 15 minutes waiting for another prime-agent \\(pid ${process.pid}\\)[\\s\\S]*${lockDir}`,
				),
			);
		} finally {
			nowSpy.mockRestore();
		}

		expect(existsSync(join(lockDir, "pid"))).toBe(true);
	});

	it("stops waiting for a bootstrap lock when the signal aborts", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = writeBootstrapLock(venv, process.pid, getCurrentProcessStartId());
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);

		await expect(ensureKernelPython({ signal: controller.signal })).rejects.toThrow(/aborted while waiting/);

		expect(existsSync(join(lockDir, "pid"))).toBe(true);
	});

	it.each([
		{
			name: "accepts an interpreter carrying the runtime and every default extra",
			write: (path: string) => writeFakePython(path, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]),
			withSkill: false,
			error: undefined,
		},
		{
			name: "accepts an interpreter that cannot import the Python skills",
			write: (path: string) => writeFakePython(path, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]),
			withSkill: true,
			error: undefined,
		},
		{
			name: "rejects an interpreter missing a default extra package",
			write: (path: string) =>
				writeFakePython(path, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter((module) => module !== "yaml")]),
			withSkill: false,
			error: /default Python packages \(yaml \(PyYAML\)\)/,
		},
		{
			name: "rejects an interpreter with a stale rlm runtime",
			write: (path: string) => writeFakePython(path, ["dill"]),
			withSkill: false,
			error: /current prime-agent-runtime with callable rlm\.spawn/,
		},
		{
			name: "rejects an interpreter exposing only the legacy harness API",
			write: (path: string) => writeFakePython(path, ["rlm"], ["_harness_methods"]),
			withSkill: false,
			error: /current prime-agent-runtime with callable rlm\.spawn/,
		},
		{
			name: "rejects an interpreter with a pre-progress-note rlm runtime",
			write: (path: string) => writeFakePython(path, ["rlm"], ["progress_note"]),
			withSkill: false,
			error: /current prime-agent-runtime with callable rlm\.spawn, rlm\.create_session, rlm\.host_request, rlm\.progress_note/,
		},
		{
			name: "rejects an interpreter missing the runtime, without bootstrapping a venv",
			write: (path: string) => writeFakePython(path, []),
			withSkill: false,
			error: /PRIME_AGENT_KERNEL_PYTHON points to a Python missing/,
		},
	])("PRIME_AGENT_KERNEL_PYTHON $name", async ({ write, withSkill, error }) => {
		const overridePython = join(tempDir, "override-python");
		write(overridePython);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;
		const options = withSkill ? { pythonSkills: [createPythonSkill()] } : {};

		if (error) {
			await expect(ensureKernelPython(options)).rejects.toThrow(error);
		} else {
			await expect(ensureKernelPython(options)).resolves.toBe(overridePython);
		}
	});

	it("resolves the venv python under Scripts\\python.exe on win32 (uv layout)", () => {
		const venv = join(tempDir, "kernel-venv");
		expect(kernelVenvPython(venv, "win32")).toBe(join(venv, "Scripts", "python.exe"));
		expect(kernelVenvPython(venv, "linux")).toBe(join(venv, "bin", "python"));
	});
});
