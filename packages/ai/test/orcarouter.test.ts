import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Model, OrcaRouterRouting } from "../src/types.js";

interface FakeOpenAIClientOptions {
	apiKey: string;
	baseURL: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string>;
}

interface CapturedCompletionsPayload {
	model?: string;
	models?: string[];
	route?: string;
	reasoning_effort?: string;
	reasoning?: { effort?: string };
	prompt_cache_key?: string;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedCompletionsPayload | undefined,
	lastClientOptions: undefined as FakeOpenAIClientOptions | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedCompletionsPayload) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};

		constructor(options: FakeOpenAIClientOptions) {
			mockState.lastClientOptions = options;
		}
	}

	return { default: FakeOpenAI };
});

const originalOrcaRouterApiKey = process.env.ORCAROUTER_API_KEY;
const originalOrcaKey = process.env.ORCA_KEY;

function restoreOrcaEnv(): void {
	if (originalOrcaRouterApiKey === undefined) {
		delete process.env.ORCAROUTER_API_KEY;
	} else {
		process.env.ORCAROUTER_API_KEY = originalOrcaRouterApiKey;
	}
	if (originalOrcaKey === undefined) {
		delete process.env.ORCA_KEY;
	} else {
		process.env.ORCA_KEY = originalOrcaKey;
	}
}

function clearOrcaEnv(): void {
	delete process.env.ORCAROUTER_API_KEY;
	delete process.env.ORCA_KEY;
}

function createOrcaRouterModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	const { compat: overrideCompat, ...rest } = overrides;
	return {
		id: "orcarouter/auto",
		name: "OrcaRouter Auto",
		api: "openai-completions",
		provider: "orcarouter",
		baseUrl: "https://api.orcarouter.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		compat: {
			supportsReasoningEffort: true,
			...overrideCompat,
		},
		...rest,
	};
}

async function captureRequest(
	options?: {
		cacheRetention?: "none" | "short" | "long";
		sessionId?: string;
		headers?: Record<string, string>;
		reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	},
	model: Model<"openai-completions"> = createOrcaRouterModel(),
) {
	await streamOpenAICompletions(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key", ...options },
	).result();

	return {
		payload: mockState.lastParams,
		headers: mockState.lastClientOptions?.defaultHeaders ?? {},
	};
}

describe("OrcaRouter env keys", () => {
	afterEach(() => {
		restoreOrcaEnv();
	});

	it("resolves ORCAROUTER_API_KEY when set", () => {
		clearOrcaEnv();
		process.env.ORCAROUTER_API_KEY = "sk-orca-primary";

		expect(findEnvKeys("orcarouter")).toEqual(["ORCAROUTER_API_KEY"]);
		expect(getEnvApiKey("orcarouter")).toBe("sk-orca-primary");
	});

	it("falls back to ORCA_KEY when only that is set", () => {
		clearOrcaEnv();
		process.env.ORCA_KEY = "sk-orca-fallback";

		expect(findEnvKeys("orcarouter")).toEqual(["ORCA_KEY"]);
		expect(getEnvApiKey("orcarouter")).toBe("sk-orca-fallback");
	});

	it("prefers ORCAROUTER_API_KEY when both are set", () => {
		clearOrcaEnv();
		process.env.ORCAROUTER_API_KEY = "sk-orca-primary";
		process.env.ORCA_KEY = "sk-orca-fallback";

		expect(findEnvKeys("orcarouter")).toEqual(["ORCAROUTER_API_KEY", "ORCA_KEY"]);
		expect(getEnvApiKey("orcarouter")).toBe("sk-orca-primary");
	});
});

describe("OrcaRouter request payload and headers", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastClientOptions = undefined;
	});

	it("sends X-OrcaRouter-Session-Id from sessionId", async () => {
		const { headers } = await captureRequest({ sessionId: "conv-1" });

		expect(headers["X-OrcaRouter-Session-Id"]).toBe("conv-1");
		expect(headers.session_id).toBeUndefined();
		expect(headers["x-session-affinity"]).toBeUndefined();
	});

	it("sends X-OrcaRouter-Session-Id when cacheRetention is none", async () => {
		const { headers } = await captureRequest({ cacheRetention: "none", sessionId: "conv-1" });

		expect(headers["X-OrcaRouter-Session-Id"]).toBe("conv-1");
		expect(headers.session_id).toBeUndefined();
		expect(headers["x-client-request-id"]).toBeUndefined();
		expect(headers["x-session-affinity"]).toBeUndefined();
	});

	it("emits fallback models and route", async () => {
		const models = ["openai/gpt-4o", "anthropic/claude-sonnet-4.6", "google/gemini-2.5-pro"];
		const { payload } = await captureRequest(
			undefined,
			createOrcaRouterModel({
				compat: {
					supportsReasoningEffort: true,
					orcaRouterRouting: { models, route: "fallback" },
				},
			}),
		);

		expect(payload?.models).toEqual(models);
		expect(payload?.route).toBe("fallback");
	});

	it("truncates fallback chains to 5 models", async () => {
		const models = [
			"openai/gpt-4o",
			"anthropic/claude-sonnet-4.6",
			"google/gemini-2.5-pro",
			"xai/grok-4",
			"deepseek/deepseek-v3.2",
			"mistralai/mistral-large",
		];
		const { payload } = await captureRequest(
			undefined,
			createOrcaRouterModel({
				compat: {
					supportsReasoningEffort: true,
					orcaRouterRouting: { models, route: "fallback" },
				},
			}),
		);

		expect(payload?.models).toEqual(models.slice(0, 5));
		expect(payload?.route).toBe("fallback");
	});

	it("omits models and route when route is not fallback", async () => {
		const omitted = await captureRequest(
			undefined,
			createOrcaRouterModel({
				compat: {
					supportsReasoningEffort: true,
					orcaRouterRouting: { models: ["openai/gpt-4o"] },
				},
			}),
		);
		expect(omitted.payload?.models).toBeUndefined();
		expect(omitted.payload?.route).toBeUndefined();

		const otherRoute: OrcaRouterRouting = {
			models: ["openai/gpt-4o"],
			route: "other" as OrcaRouterRouting["route"],
		};
		const notFallback = await captureRequest(
			undefined,
			createOrcaRouterModel({
				compat: {
					supportsReasoningEffort: true,
					orcaRouterRouting: otherRoute,
				},
			}),
		);
		expect(notFallback.payload?.models).toBeUndefined();
		expect(notFallback.payload?.route).toBeUndefined();
	});

	it("sends flat reasoning_effort instead of OpenRouter reasoning.effort", async () => {
		const { payload } = await captureRequest({ reasoningEffort: "high" });

		expect(payload?.reasoning_effort).toBe("high");
		expect(payload?.reasoning).toBeUndefined();
	});
});

const catalogAuto = (getModel as (provider: string, modelId: string) => Model<"openai-completions"> | undefined)(
	"orcarouter",
	"orcarouter/auto",
);

describe.skipIf(!catalogAuto)("OrcaRouter catalog", () => {
	it("registers orcarouter/auto", () => {
		expect(catalogAuto?.id).toBe("orcarouter/auto");
		expect(catalogAuto?.provider).toBe("orcarouter");
		expect(catalogAuto?.api).toBe("openai-completions");
		expect(catalogAuto?.baseUrl).toBe("https://api.orcarouter.ai/v1");
		expect(catalogAuto?.featured).toBe(true);
		expect(catalogAuto?.reasoning).toBe(false);
	});
});
