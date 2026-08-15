/**
 * Strip parent-daemon supervisor/worker env so real-process tests do not
 * attach to the agent that launched the test runner.
 */
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

export function isolatedDaemonProcessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
	for (const key of PARENT_DAEMON_ENV_KEYS) {
		if (!(key in overrides) || overrides[key] === undefined) {
			delete env[key];
		}
	}
	return env;
}
