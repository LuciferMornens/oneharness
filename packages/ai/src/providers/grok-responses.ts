/**
 * xAI Grok subscription Responses provider.
 *
 * Streams through xAI's CLI chat proxy (`cli-chat-proxy.grok.com`), which
 * bills SuperGrok / X Premium+ subscriptions instead of api.x.ai pay-per-token
 * credits. The proxy speaks the OpenAI Responses protocol and authenticates
 * with the OAuth bearer obtained via the "grok" OAuth provider, plus a fixed
 * set of Grok CLI proxy headers.
 */

import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.js";
import {
	assertValidReasoningCapabilities,
	assertValidReasoningEffortValue,
	getReasoningCapabilities,
	resolveSimpleThinkingLevel,
	resolveThinkingLevel,
	resolveThinkingOffValue,
	supportsFastMode,
} from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import {
	formatStreamFailureMessage,
	recordStreamFailure,
	streamFailureFromStopReason,
} from "../utils/stream-failure.js";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

export const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

// Truthful third-party client attribution for the proxy's client gate.
const GROK_CLIENT_IDENTIFIER = "pi-ai";
const GROK_CLIENT_VERSION = "0.7.2";

const GROK_TOOL_CALL_PROVIDERS = new Set(["grok"]);
const ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";

// Grok Responses-specific options
export interface GrokResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningEffortValue?: string;
	/** false overrides reasoningEffort and reasoningSummary; undefined preserves the provider/model default. */
	reasoningEnabled?: boolean;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
}

function randomRequestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `req-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function resolveClientMode(): "interactive" | "headless" {
	if (typeof process === "undefined") return "headless";
	return process.stdin?.isTTY === true && process.stdout?.isTTY === true ? "interactive" : "headless";
}

/**
 * Build the per-request Grok CLI proxy header contract.
 * Exported for tests.
 */
export function buildGrokProxyHeaders(modelId: string, sessionId?: string): Record<string, string> {
	const conversationId = sessionId || randomRequestId();
	const normalizedModelId = modelId.toLowerCase().split("/").pop() || modelId.toLowerCase();
	return {
		"User-Agent": `${GROK_CLIENT_IDENTIFIER}/${GROK_CLIENT_VERSION}`,
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-authenticateresponse": "authenticate-response",
		"x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
		"x-grok-client-version": GROK_CLIENT_VERSION,
		"x-grok-client-mode": resolveClientMode(),
		"x-grok-conv-id": conversationId,
		"x-grok-session-id": conversationId,
		"x-grok-req-id": randomRequestId(),
		"x-grok-model-override": normalizedModelId,
	};
}

/**
 * Generate function for the xAI Grok subscription Responses API
 */
export const streamGrokResponses: StreamFunction<"grok-responses", GrokResponsesOptions> = (
	model: Model<"grok-responses">,
	context: Context,
	options?: GrokResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) {
				throw new Error(
					`No credentials for provider: ${model.provider}. Log in with the xAI Grok OAuth provider first.`,
				);
			}

			const client = createClient(model, apiKey, options);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
			};
			const { data: openaiStream, response } = await client.responses.create(params, requestOptions).withResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			const requestId = response.headers.get("x-request-id") ?? undefined;
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw streamFailureFromStopReason(output.stopReasonRaw, { requestId });
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatStreamFailureMessage(error);
			recordStreamFailure(model, output, error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleGrokResponses: StreamFunction<"grok-responses", SimpleStreamOptions> = (
	model: Model<"grok-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No credentials for provider: ${model.provider}. Log in with the xAI Grok OAuth provider first.`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (getReasoningCapabilities(model)?.control === "fixed") {
		return streamGrokResponses(model, context, base satisfies GrokResponsesOptions);
	}
	// Grok fast mode is not a service tier on the proxy: it is low reasoning
	// effort on the same model id, so map the "priority" tier to "low".
	const fastMode = options?.serviceTier === "priority" && supportsFastMode(model);
	const resolvedReasoning = resolveSimpleThinkingLevel(model, fastMode ? "low" : options?.reasoning);

	return streamGrokResponses(model, context, {
		...base,
		reasoningEffort: resolvedReasoning?.enabled
			? (resolvedReasoning.level as Exclude<typeof resolvedReasoning.level, "off">)
			: undefined,
		reasoningEffortValue:
			resolvedReasoning?.enabled && typeof resolvedReasoning.providerValue === "string"
				? resolvedReasoning.providerValue
				: undefined,
		reasoningEnabled: resolvedReasoning?.enabled,
	} satisfies GrokResponsesOptions);
};

function createClient(model: Model<"grok-responses">, apiKey: string, options?: GrokResponsesOptions) {
	const headers: Record<string, string> = {
		...buildGrokProxyHeaders(model.id, options?.sessionId),
		...model.headers,
	};

	// Merge options headers last so they can override defaults
	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl || GROK_CLI_BASE_URL,
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
	});
}

function buildParams(model: Model<"grok-responses">, context: Context, options?: GrokResponsesOptions) {
	const capabilities = assertValidReasoningCapabilities(model);
	if (capabilities?.control === "effort" && options?.reasoningEffortValue !== undefined) {
		assertValidReasoningEffortValue(model, "request", options.reasoningEffortValue);
	}
	const messages = convertResponsesMessages(model, context, GROK_TOOL_CALL_PROVIDERS);

	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		// The proxy must never store responses server-side; reasoning continuity
		// is carried client-side through encrypted reasoning items.
		store: false,
		include: [ENCRYPTED_REASONING_INCLUDE],
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools);
	}

	if (model.reasoning && getReasoningCapabilities(model)?.control !== "fixed") {
		if (options?.reasoningEnabled === false) {
			const offValue = resolveThinkingOffValue(model, "none");
			if (typeof offValue === "string") {
				params.reasoning = {
					effort: offValue as NonNullable<typeof params.reasoning>["effort"],
				};
			}
		} else if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (options.reasoningEffortValue ??
					resolveThinkingLevel(model, options.reasoningEffort)?.providerValue ??
					options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
		}
	}

	return params;
}
