import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerFauxProvider } from "../../../ai/src/index.js";
import type { ExtensionAPI } from "../../src/index.js";

/**
 * Faux provider for the daemon-session kernel concurrency proof.
 *
 * Every CLI process loads this extension inside its own daemon worker, so each
 * worker gets a private two-step response queue:
 *
 *  1. An ipython tool call that registers the kernel at a file barrier, waits
 *     until every expected kernel has arrived, then prints the kernel process
 *     identity and the owner pid the ReplKernelManager stamps into the kernel
 *     environment. Only overlapping kernels can all see a full barrier.
 *  2. A final assistant message that reports the worker process identity;
 *     the worker's parent is the daemon supervisor that spawned it.
 *
 * The barrier lives beside the session's working directory: the test creates
 * `<root>/barrier/expected` holding the kernel count and starts each session
 * in `<root>/cwd-<index>`.
 */
const BARRIER_WAIT_SECONDS = 90;

const kernelIdentityCode = [
	"import os",
	"import sys",
	"import time",
	'barrier = os.path.join(os.path.dirname(os.getcwd()), "barrier")',
	'with open(os.path.join(barrier, "expected"), encoding="utf-8") as expected_file:',
	"    expected = int(expected_file.read())",
	'open(os.path.join(barrier, f"arrived-{os.getpid()}"), "w").close()',
	"def arrived():",
	'    return sum(name.startswith("arrived-") for name in os.listdir(barrier))',
	`deadline = time.monotonic() + ${BARRIER_WAIT_SECONDS}`,
	"while arrived() < expected and time.monotonic() < deadline:",
	"    time.sleep(0.1)",
	'owner_pid = os.environ["PRIME_AGENT_KERNEL_OWNER_PID"]',
	'print(f"KERNEL_PID={os.getpid()} KERNEL_OWNER_PID={owner_pid} BARRIER_ARRIVED={arrived()} PY={sys.executable}")',
].join("\n");

const workerIdentityText = `WORKER_PID=${process.pid} SUPERVISOR_PID=${process.ppid}`;

export default function registerDaemonKernelConcurrencyFauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});

	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ipython", { code: kernelIdentityCode })], { stopReason: "toolUse" }),
		fauxAssistantMessage(workerIdentityText),
	]);

	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) {
		throw new Error("Faux API provider was not registered");
	}

	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: apiProvider.streamSimple,
		models: faux.models.map((model) => ({
			api: model.api,
			baseUrl: model.baseUrl,
			contextWindow: model.contextWindow,
			cost: model.cost,
			id: model.id,
			input: model.input,
			maxTokens: model.maxTokens,
			name: model.name,
			reasoning: model.reasoning,
		})),
	});
}
