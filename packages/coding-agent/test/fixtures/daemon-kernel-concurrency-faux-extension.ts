import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerFauxProvider } from "../../../ai/src/index.js";
import type { ExtensionAPI } from "../../src/index.js";

/**
 * Faux provider for the daemon-session kernel concurrency proof.
 *
 * Every CLI process loads this extension inside its own daemon worker, so each
 * worker gets a private two-step response queue:
 *
 *  1. An ipython tool call that prints the kernel process identity and the
 *     owner pid the ReplKernelManager stamps into the kernel environment.
 *  2. A final assistant message that reports the worker process identity;
 *     the worker's parent is the daemon supervisor that spawned it.
 */
const kernelIdentityCode = [
	"import os",
	"import sys",
	'owner_pid = os.environ["PRIME_AGENT_KERNEL_OWNER_PID"]',
	'print(f"KERNEL_PID={os.getpid()} KERNEL_OWNER_PID={owner_pid} PY={sys.executable}")',
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
