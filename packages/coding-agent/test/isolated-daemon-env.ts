/**
 * Strip parent-daemon supervisor/worker env so real-process tests do not
 * attach to the agent that launched the test runner.
 */
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createSecureTempDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	chmodSync(directory, 0o700);
	return directory;
}

const PARENT_DAEMON_ENV_KEYS = [
	"PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR",
	"PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SELECTED_REGISTRY_DIR",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD",
	"PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET",
	"PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL",
	"PRIME_AGENT_INTERNAL_SESSION_LEASES",
	"PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID",
] as const;

export function isolatedDaemonRegistryDir(agentDir: string): string {
	const registryDir = join(agentDir, "supervisor-owners");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(registryDir, { recursive: true });
	chmodSync(agentDir, 0o700);
	chmodSync(registryDir, 0o700);
	return registryDir;
}

export function isolatedDaemonProcessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
	for (const key of PARENT_DAEMON_ENV_KEYS) {
		if (!(key in overrides) || overrides[key] === undefined) {
			delete env[key];
		}
	}
	return env;
}
