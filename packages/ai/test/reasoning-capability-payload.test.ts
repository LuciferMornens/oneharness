import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamSimple } from "../src/stream.js";
import type { Model, ModelReasoningCapabilities } from "../src/types.js";

const mockState = vi.hoisted(() => ({ lastParams: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: {}, finish_reason: "stop" }] };
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const context = { messages: [{ role: "user" as const, content: "Hi", timestamp: 0 }] };

async function payload(
	provider: "deepseek" | "openrouter" | "prime-inference" | "xai" | "zai",
	modelId: string,
	reasoning?: "off" | "low" | "medium" | "high" | "xhigh" | "max",
) {
	let captured: unknown;
	await streamSimple(getModel(provider, modelId as never), context, {
		apiKey: "test",
		...(reasoning !== undefined ? { reasoning } : {}),
		onPayload: (value) => {
			captured = value;
		},
	}).result();
	return (captured ?? mockState.lastParams) as Record<string, unknown>;
}

async function directPayload(
	model: Model<"openai-completions">,
	options: Pick<OpenAICompletionsOptions, "reasoningEffort" | "reasoningEnabled">,
) {
	let captured: unknown;
	await streamOpenAICompletions(model, context, {
		apiKey: "test",
		...options,
		onPayload: (value) => {
			captured = value;
		},
	}).result();
	return (captured ?? mockState.lastParams) as Record<string, unknown>;
}

describe("reasoning capability payloads", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it.each(["low", "high", "max"] as const)("serializes DeepSeek V4 %s as an exact native effort", async (level) => {
		expect(await payload("deepseek", "deepseek-v4-flash", level)).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: level,
		});
		expect(await directPayload(getModel("deepseek", "deepseek-v4-flash"), { reasoningEffort: level })).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: level,
		});
	});

	it("disables DeepSeek thinking without sending an effort", async () => {
		const params = await payload("deepseek", "deepseek-v4-flash", "off");
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("uses OpenRouter's reasoning object for preserved DeepSeek V4 routes", async () => {
		const enabled = await payload("openrouter", "deepseek/deepseek-v4-flash", "xhigh");
		expect(enabled.reasoning).toEqual({ effort: "xhigh" });
		expect(enabled.thinking).toBeUndefined();
		expect(enabled.reasoning_effort).toBeUndefined();

		const datedAlias = await payload("openrouter", "deepseek/deepseek-v4-flash-0731", "max");
		expect(datedAlias.reasoning).toEqual({ effort: "max" });

		const disabled = await payload("openrouter", "deepseek/deepseek-v4-flash", "off");
		expect(disabled.reasoning).toEqual({ effort: "none" });
		expect(disabled.thinking).toBeUndefined();
	});

	it("gives an explicit reasoning disable precedence over an effort", async () => {
		const openRouter = await directPayload(getModel("openrouter", "deepseek/deepseek-v4-flash"), {
			reasoningEnabled: false,
			reasoningEffort: "high",
		});
		expect(openRouter.reasoning).toEqual({ effort: "none" });

		const deepSeek = await directPayload(getModel("deepseek", "deepseek-v4-flash"), {
			reasoningEnabled: false,
			reasoningEffort: "high",
		});
		expect(deepSeek.thinking).toEqual({ type: "disabled" });
		expect(deepSeek.reasoning_effort).toBeUndefined();

		const prime = await directPayload(getModel("prime-inference", "openai/gpt-5.6"), {
			reasoningEnabled: false,
			reasoningEffort: "high",
		});
		expect(prime.reasoning_effort).toBe("none");
	});

	it("only serializes direct toggle disables when the exact contract supports off", async () => {
		const base = getModel("zai", "glm-4.7");
		for (const thinkingFormat of ["zai", "moonshot", "qwen", "qwen-chat-template", "deepseek"] as const) {
			const optionalModel: Model<"openai-completions"> = {
				...base,
				provider: `optional-${thinkingFormat}`,
				compat: { ...base.compat, thinkingFormat, supportsReasoningEffort: true },
				thinkingLevelMap: { off: "off", high: "high" },
				reasoningCapabilities: {
					control: "toggle",
					levels: { off: "off", high: "high" },
				},
			};
			const optionalParams = await directPayload(optionalModel, {
				reasoningEnabled: false,
				reasoningEffort: "high",
			});
			if (thinkingFormat === "qwen") {
				expect(optionalParams.enable_thinking).toBe(false);
			} else if (thinkingFormat === "qwen-chat-template") {
				expect(optionalParams.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });
			} else {
				expect(optionalParams.thinking).toEqual({ type: "disabled" });
			}
			expect(optionalParams.reasoning_effort).toBeUndefined();

			const mandatoryModel: Model<"openai-completions"> = {
				...optionalModel,
				provider: `mandatory-${thinkingFormat}`,
				thinkingLevelMap: { off: null, high: "high" },
				reasoningCapabilities: {
					control: "toggle",
					levels: { off: null, high: "high" },
				},
			};
			const mandatoryParams = await directPayload(mandatoryModel, {
				reasoningEnabled: false,
				reasoningEffort: "high",
			});
			expect(mandatoryParams.thinking).toBeUndefined();
			expect(mandatoryParams.enable_thinking).toBeUndefined();
			expect(mandatoryParams.chat_template_kwargs).toBeUndefined();
			expect(mandatoryParams.reasoning_effort).toBeUndefined();
		}
	});

	it("serializes numeric OpenAI-compatible budgets through the route budget field", async () => {
		const base = getModel("zai", "glm-4.7");
		const genericBudgetModel: Model<"openai-completions"> = {
			...base,
			provider: "custom-budget",
			baseUrl: "https://example.com/v1",
			reasoningCapabilities: {
				control: "budget",
				levels: { off: 0, high: 8192 },
			},
			compat: { ...base.compat, thinkingFormat: "openai", supportsReasoningEffort: false },
		};

		const enabled = await directPayload(genericBudgetModel, { reasoningEffort: "high" });
		expect(enabled.reasoning_budget).toBe(8192);
		expect(enabled.reasoning_effort).toBeUndefined();

		const disabled = await directPayload(genericBudgetModel, {
			reasoningEnabled: false,
			reasoningEffort: "high",
		});
		expect(disabled.reasoning_budget).toBe(0);
		expect(disabled.reasoning_effort).toBeUndefined();
		expect(getModel("google", "gemini-2.5-flash").thinkingLevelMap).toBeUndefined();
		expect(getModel("google", "gemini-2.5-flash").reasoningCapabilities?.levels.high).toBe(24576);

		const openRouterBudgetModel: Model<"openai-completions"> = {
			...genericBudgetModel,
			provider: "custom-openrouter-budget",
			compat: { ...genericBudgetModel.compat, thinkingFormat: "openrouter" },
		};
		const openRouter = await directPayload(openRouterBudgetModel, { reasoningEffort: "high" });
		expect(openRouter.reasoning).toEqual({ max_tokens: 8192 });
		expect(openRouter.reasoning_budget).toBeUndefined();
		expect(openRouter.reasoning_effort).toBeUndefined();

		const invalidModel: Model<"openai-completions"> = {
			...genericBudgetModel,
			provider: "invalid-qwen-budget",
			compat: { ...genericBudgetModel.compat, thinkingFormat: "qwen" },
		};
		const invalidResult = await streamOpenAICompletions(invalidModel, context, {
			apiKey: "test",
			reasoningEffort: "high",
		}).result();
		expect(invalidResult.stopReason).toBe("error");
		expect(invalidResult.errorMessage).toContain('thinkingFormat "qwen" cannot serialize a numeric reasoning budget');
	});

	it.each([
		["numeric effort", { control: "effort", levels: { high: 8192 } }, "must use a non-empty string"],
		["string budget", { control: "budget", levels: { high: "8192" } }, "must use a numeric token value"],
		["fractional budget", { control: "budget", levels: { high: 1.5 } }, "finite integer token value"],
		["NaN budget", { control: "budget", levels: { high: Number.NaN } }, "finite integer token value"],
		[
			"infinite budget",
			{ control: "budget", levels: { high: Number.POSITIVE_INFINITY } },
			"finite integer token value",
		],
		["zero budget", { control: "budget", levels: { high: 0 } }, "at least 1 tokens"],
		["negative sentinel", { control: "budget", levels: { high: -1 } }, "at least 1 tokens"],
		[
			"positive off budget",
			{ control: "budget", levels: { off: 1024, high: 8192 } },
			'budget level "off" must disable reasoning',
		],
	] as const)(
		"rejects an invalid OpenAI-compatible %s contract before payload construction",
		async (_name, contract, message) => {
			let payloadBuilt = false;
			const base = getModel("zai", "glm-4.7");
			const model: Model<"openai-completions"> = {
				...base,
				provider: "invalid-contract",
				baseUrl: "https://example.com/v1",
				reasoningCapabilities: contract as unknown as ModelReasoningCapabilities,
				compat: { ...base.compat, thinkingFormat: "openai" },
			};
			const result = await streamOpenAICompletions(model, context, {
				apiKey: "test",
				reasoningEffort: "high",
				onPayload: () => {
					payloadBuilt = true;
				},
			}).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(message);
			expect(payloadBuilt).toBe(false);
		},
	);

	it("validates a legacy thinkingLevelMap override after merging it into a generated contract", async () => {
		let payloadBuilt = false;
		const model: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			thinkingLevelMap: { high: "" },
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			reasoning: "high",
			onPayload: () => {
				payloadBuilt = true;
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('effort level "high" must use a non-empty string');
		expect(payloadBuilt).toBe(false);
	});

	it("rejects legacy overlays that add choices to a generated fixed contract", async () => {
		const model: Model<"openai-responses"> = {
			...getModel("github-copilot", "gpt-5-mini"),
			thinkingLevelMap: { off: "none", high: "always" },
		};

		const result = await streamSimple(model, context, { apiKey: "test", reasoning: "off" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(
			"legacy thinkingLevelMap overlay cannot add choices to an intrinsically fixed route",
		);
	});

	it("serializes preserved Prime GPT-5.6 levels as native efforts", async () => {
		const params = await payload("prime-inference", "openai/gpt-5.6", "low");
		expect(params.reasoning_effort).toBe("low");
		expect(params.reasoning).toBeUndefined();
		expect(params.thinking).toBeUndefined();
	});

	it("uses OpenRouter-derived per-alias efforts for Prime DeepSeek V4", async () => {
		const flashModel = getModel("prime-inference", "deepseek/deepseek-v4-flash");
		expect(flashModel.reasoningCapabilities?.levels).toMatchObject({ low: null, high: "high", xhigh: "xhigh" });
		expect(await payload("prime-inference", flashModel.id, "xhigh")).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "xhigh",
		});

		const datedModel = getModel("prime-inference", "deepseek/deepseek-v4-flash-0731");
		expect(datedModel.reasoningCapabilities?.levels).toMatchObject({ low: "low", xhigh: null, max: "max" });
		expect(await payload("prime-inference", datedModel.id, "low")).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "low",
		});
		expect(await payload("prime-inference", datedModel.id, "max")).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "max",
		});

		const disabled = await payload("prime-inference", flashModel.id, "off");
		expect(disabled.thinking).toEqual({ type: "disabled" });
		expect(disabled.reasoning_effort).toBeUndefined();
	});

	it("preserves the DeepSeek default when reasoning is omitted", async () => {
		const params = await payload("deepseek", "deepseek-v4-flash");
		expect(params.thinking).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("serializes Z.AI GLM-5.2 high and max efforts", async () => {
		for (const level of ["high", "max"] as const) {
			expect(await payload("zai", "glm-5.2", level)).toMatchObject({
				thinking: { type: "enabled" },
				reasoning_effort: level,
			});
			expect(await directPayload(getModel("zai", "glm-5.2"), { reasoningEffort: level })).toMatchObject({
				thinking: { type: "enabled" },
				reasoning_effort: level,
			});
		}
	});

	it("uses a pure toggle for older Z.AI models", async () => {
		const enabled = await payload("zai", "glm-4.7", "high");
		expect(enabled.thinking).toEqual({ type: "enabled" });
		expect(enabled.reasoning_effort).toBeUndefined();

		const disabled = await payload("zai", "glm-4.7", "off");
		expect(disabled.thinking).toEqual({ type: "disabled" });
		expect(disabled.reasoning_effort).toBeUndefined();

		expect(await directPayload(getModel("zai", "glm-4.7"), { reasoningEffort: "high" })).toMatchObject({
			thinking: { type: "enabled" },
		});

		const base = getModel("zai", "glm-4.7");
		for (const thinkingFormat of ["qwen", "qwen-chat-template"] as const) {
			const model: Model<"openai-completions"> = {
				...base,
				provider: `custom-${thinkingFormat}`,
				compat: { ...base.compat, thinkingFormat },
			};
			const params = await directPayload(model, { reasoningEffort: "high" });
			if (thinkingFormat === "qwen") {
				expect(params.enable_thinking).toBe(true);
			} else {
				expect(params.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
			}
		}
	});

	it("serializes documented xAI Grok effort values", async () => {
		expect(await payload("xai", "grok-4.5", "medium")).toMatchObject({ reasoning_effort: "medium" });
	});

	it("omits reasoning controls for xAI routes without a documented control", async () => {
		const params = await payload("xai", "grok-4.3", "high");
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.thinking).toBeUndefined();

		const explicitlyDisabled = await directPayload(getModel("xai", "grok-4.3"), {
			reasoningEnabled: false,
			reasoningEffort: "high",
		});
		expect(explicitlyDisabled.reasoning_effort).toBeUndefined();
		expect(explicitlyDisabled.thinking).toBeUndefined();
	});
});
