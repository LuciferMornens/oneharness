import { spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	getKernelVenvDir,
	getKernelVenvsRoot,
	type KernelPythonSkill,
	resolveRuntimeIdentity,
} from "../src/core/kernel/bootstrap.js";
import { getCurrentProcessStartId } from "../src/core/session-lease.js";

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

function writeFakePython(filePath: string, importableModules: readonly string[]): void {
	const cases = importableModules.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`).join("\n");
	const runtimeCase = importableModules.includes("rlm") ? '    *"_harness_methods"*) exit 0 ;;' : "";
	writeExecutable(
		filePath,
		[
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			cases,
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
			'  for arg in "$@"; do',
			'    if [ "$UV_FAIL_ARG" != "" ] && [ "$arg" = "$UV_FAIL_ARG" ]; then',
			"      exit 1",
			"    fi",
			"  done",
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

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
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

	it("bootstraps a missing venv with uv, prime-agent-runtime, and default extra packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("python install 3.11");
		expect(log).toContain(`venv ${venv} --python 3.11 --seed`);
		expect(log).toContain("pip install --python");
		expect(log).not.toContain("ipykernel");
		expect(log).toContain("prime-agent-runtime");
		expect(log).toContain("dill");
		for (const uvArg of DEFAULT_RLM_EXTRA_UV_ARGS) {
			expect(log).toContain(uvArg);
		}
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version).toEqual({
			schema: 9,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: [],
		});
		expect(version.runtime).toMatch(/^sha256:/);
	});

	it("routes bootstrap progress through the provided callback", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const progress: string[] = [];
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await expect(ensureKernelPython({ onProgress: (message) => progress.push(message) })).resolves.toBe(
				join(venv, "bin", "python"),
			);
		} finally {
			stderrWrite.mockRestore();
		}

		expect(progress).toEqual(expect.arrayContaining(["› setting up python kernel (one-time, ~30s)…", "✓ ready"]));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("setting up python kernel"));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("ready"));
	});

	it("installs Python skills into the bootstrapped venv", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
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

	it("installs sibling Python skill dependencies with dependent editable packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("agent-observe");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "agent-observe");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: dependencySkill.importName,
				packagePath: dependencySkill.packagePath,
				pyprojectPath: dependencySkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependencySkill.pyprojectPath),
			},
			{
				importName: dependentSkill.importName,
				packagePath: dependentSkill.packagePath,
				pyprojectPath: dependentSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependentSkill.pyprojectPath),
			},
		]);
	});

	it("installs sibling Python skill dependencies when package and directory names differ", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("attach-image");
		writeFileSync(
			dependencySkill.pyprojectPath,
			`[project]
name = "prime-agent-skill-attach-image"
version = "0.1.0"
`,
		);
		const dependentSkill = createPythonSkillWithDependency(
			"orchestration-heartbeat",
			"prime-agent-skill-attach-image",
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("parses Python skill dependencies with extras", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("gidgethub");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "gidgethub[httpx]>4.0.0");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("syncs a warm venv when a Python skill pyproject changes", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		const pythonSkill = createPythonSkill();
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [pythonSkill]);
		writeFileSync(
			pythonSkill.pyprojectPath,
			`[project]
name = "${pythonSkill.name}"
version = "0.1.0"
dependencies = ["httpx"]
`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(python);

		const log = readFileSync(logPath, "utf8");
		expect(log).not.toContain(`venv ${venv} --python 3.11 --seed`);
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills[0].pyprojectHash).toBe(pyprojectHash(pythonSkill.pyprojectPath));
	});

	it("continues when a Python skill editable install fails and retries it next startup", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const goodSkill = createPythonSkill("good-skill");
		const brokenSkill = createPythonSkill("broken-skill");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.UV_FAIL_ARG = brokenSkill.packagePath;

		await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
			join(venv, "bin", "python"),
		);

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${goodSkill.packagePath}`);
		expect(log).toContain(`--editable ${brokenSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: goodSkill.importName,
				packagePath: goodSkill.packagePath,
				pyprojectPath: goodSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(goodSkill.pyprojectPath),
			},
		]);

		await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
			join(venv, "bin", "python"),
		);

		const retryLog = readFileSync(logPath, "utf8");
		expect(retryLog.split("\n").filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
		expect(
			retryLog.split("\n").filter((line) => line.includes(`--editable ${brokenSkill.packagePath}`)),
		).toHaveLength(2);
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

	it("rebuilds a warm venv with legacy unhashed Python skill manifest entries", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		const pythonSkill = createPythonSkill();
		mkdirSync(join(venv, "bin"), { recursive: true });
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
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
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

	it("reuses a current warm venv without invoking uv", async () => {
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);
	});

	it("rebuilds a warm venv whose recorded runtime hash no longer matches local source", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
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
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.runtime).toBe(runtimeIdentity);
	});

	it("rebuilds a warm venv with a stale rlm runtime", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import rlm") exit 0 ;;',
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
	});

	it("rebuilds a broken venv", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
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

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
		expect(existsSync(lockDir)).toBe(false);
	});

	it("reclaims a bootstrap lock whose owner pid was reused by another process", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = writeBootstrapLock(venv, process.pid, "proc:0");

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
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
		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
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

	it("uses PRIME_AGENT_KERNEL_PYTHON as an override contract", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).resolves.toBe(overridePython);
	});

	it("allows PRIME_AGENT_KERNEL_PYTHON missing Python skill imports", async () => {
		const overridePython = join(tempDir, "override-python");
		const pythonSkill = createPythonSkill();
		writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(overridePython);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON missing default extra packages", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter((name) => name !== "yaml")]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/default Python packages \(yaml \(PyYAML\)\)/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a stale rlm runtime", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["dill"]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a legacy harness API", async () => {
		const overridePython = join(tempDir, "override-python");
		writeExecutable(
			overridePython,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import rlm") exit 0 ;;',
				'    *"_harness_methods"*) exit 1 ;;',
				"    *\"assert not hasattr(rlm.rlm, 'background')\"*) exit 0 ;;",
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("fails an invalid PRIME_AGENT_KERNEL_PYTHON without bootstrapping", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, []);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/PRIME_AGENT_KERNEL_PYTHON points to a Python missing/);
	});
});
