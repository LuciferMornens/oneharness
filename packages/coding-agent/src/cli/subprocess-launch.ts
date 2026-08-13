import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isBunBinary } from "../config.js";

export interface CliSubprocessLaunchSpec {
	command: string;
	args: string[];
}

export function createCliSubprocessEnv(
	source: NodeJS.ProcessEnv = process.env,
	entrypoint = process.argv[1],
	execArgs: readonly string[] = process.execArgv,
): NodeJS.ProcessEnv {
	const environment = { ...source };
	if (environment.TSX_TSCONFIG_PATH !== undefined || !entrypoint || !execArgs.some((arg) => arg.includes("tsx"))) {
		return environment;
	}
	let directory = dirname(resolve(entrypoint));
	while (true) {
		const tsconfigPath = join(directory, "tsconfig.json");
		if (existsSync(tsconfigPath) && existsSync(join(directory, "node_modules", "tsx", "package.json"))) {
			environment.TSX_TSCONFIG_PATH = tsconfigPath;
			return environment;
		}
		const parent = dirname(directory);
		if (parent === directory) {
			return environment;
		}
		directory = parent;
	}
}

function quotePosixCommandArgument(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShellCommandArgument(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function quoteCmdCommandArgument(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
}

type CommandShell = "cmd" | "posix" | "powershell";

function formatCommand(values: readonly string[], shell: CommandShell): string {
	if (shell === "powershell") {
		return `& ${values.map(quotePowerShellCommandArgument).join(" ")}`;
	}
	if (shell === "cmd") return values.map(quoteCmdCommandArgument).join(" ");
	return values.map(quotePosixCommandArgument).join(" ");
}

function commandShellForLauncher(launcherPath: string, defaultShell: CommandShell): CommandShell {
	if (/\.ps1$/iu.test(launcherPath)) return "powershell";
	if (/\.(?:cmd|bat)$/iu.test(launcherPath)) return "cmd";
	if (/\.(?:ba)?sh$/iu.test(launcherPath)) return "posix";
	return defaultShell;
}

export function formatCurrentCliCommand(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): string {
	const launcherPath = environment.PRIME_AGENT_LAUNCHER_PATH;
	if (launcherPath) {
		const defaultShell = process.platform === "win32" ? "powershell" : "posix";
		return formatCommand([launcherPath, ...args], commandShellForLauncher(launcherPath, defaultShell));
	}
	const launch = createCliSubprocessLaunchSpec(args);
	return formatCommand([launch.command, ...launch.args], process.platform === "win32" ? "powershell" : "posix");
}

export function createCliSubprocessLaunchSpec(
	args: readonly string[],
	executable = process.execPath,
	execArgs: readonly string[] = process.execArgv,
	entrypoint = process.argv[1],
): CliSubprocessLaunchSpec {
	if (isBunBinary) {
		return { command: executable, args: [...args] };
	}
	if (!entrypoint) {
		throw new Error("Cannot determine current CLI entrypoint for subprocess launch");
	}
	const resolvedEntrypoint = isAbsolute(entrypoint) ? entrypoint : resolve(entrypoint);
	return { command: executable, args: [...execArgs, resolvedEntrypoint, ...args] };
}
