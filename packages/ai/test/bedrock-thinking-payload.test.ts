import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { type BedrockOptions, streamBedrock, streamSimpleBedrock } from "../src/providers/amazon-bedrock.js";
import type { Context, Model, ModelReasoningCapabilities } from "../src/types.js";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

interface BedrockThinkingPayload {
	inferenceConfig?: { maxTokens?: number; temperature?: number };
	additionalModelRequestFields?: {
		thinking?: { type: string; budget_tokens?: number; display?: string };
		output_config?: { effort?: string };
		reasoningConfig?: { type: string; maxReasoningEffort?: string };
		anthropic_beta?: string[];
	};
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"bedrock-converse-stream">,
	options?: BedrockOptions,
): Promise<BedrockThinkingPayload> {
	let capturedPayload: BedrockThinkingPayload | undefined;
	const s = streamBedrock(model, makeContext(), {
		...options,
		reasoning: options?.reasoning ?? "high",
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedPayload = payload as BedrockThinkingPayload;
			return payload;
		},
	});

	for await (const event of s) {
		if (event.type === "error") {
			break;
		}
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}

	return capturedPayload;
}

async function captureSimplePayload(
	model: Model<"bedrock-converse-stream">,
	options?: Parameters<typeof streamSimpleBedrock>[2],
): Promise<BedrockThinkingPayload> {
	let capturedPayload: BedrockThinkingPayload | undefined;
	const stream = streamSimpleBedrock(model, makeContext(), {
		...options,
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedPayload = payload as BedrockThinkingPayload;
			return payload;
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected Bedrock payload to be captured before request abort");
	return capturedPayload;
}

describe("Bedrock thinking payload", () => {
	it("serializes Nova 2 Lite reasoningConfig and preserves its default-disabled mode", async () => {
		const model = getModel("amazon-bedrock", "amazon.nova-2-lite-v1:0");
		expect(model.reasoningCapabilities).toMatchObject({
			control: "effort",
			levels: { off: "off", low: "low", medium: "medium", high: "high" },
		});

		const low = await capturePayload(model, { reasoning: "low", temperature: 0.4, maxTokens: 1000 });
		expect(low.additionalModelRequestFields?.reasoningConfig).toEqual({
			type: "enabled",
			maxReasoningEffort: "low",
		});
		expect(low.inferenceConfig).toEqual({ maxTokens: 1000, temperature: 0.4 });

		const high = await capturePayload(model, { reasoning: "high", temperature: 0.4, maxTokens: 1000 });
		expect(high.additionalModelRequestFields?.reasoningConfig).toEqual({
			type: "enabled",
			maxReasoningEffort: "high",
		});
		expect(high.inferenceConfig).toEqual({});

		let offPayload: BedrockThinkingPayload | undefined;
		const stream = streamSimpleBedrock(model, makeContext(), {
			reasoning: "off",
			temperature: 0.4,
			signal: AbortSignal.abort(),
			onPayload: (value) => {
				offPayload = value as BedrockThinkingPayload;
				return value;
			},
		});
		await stream.result();
		expect(offPayload?.additionalModelRequestFields).toBeUndefined();
		expect(offPayload?.inferenceConfig?.temperature).toBe(0.4);
	});

	it("preserves temperature for fixed DeepSeek reasoning routes", async () => {
		const payload = await capturePayload(getModel("amazon-bedrock", "deepseek.r1-v1:0"), {
			temperature: 0.5,
		});

		expect(payload.inferenceConfig?.temperature).toBe(0.5);
		expect(payload.additionalModelRequestFields).toBeUndefined();
	});

	it("uses numeric capability budgets in max-token adjustment and clamps the budget below max tokens", async () => {
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			maxTokens: 4096,
			reasoningCapabilities: { control: "budget", supportsOff: true, levels: { high: 10000 } },
		};
		let payload: BedrockThinkingPayload | undefined;
		const stream = streamSimpleBedrock(model, makeContext(), {
			reasoning: "high",
			maxTokens: 1000,
			temperature: 0.5,
			signal: AbortSignal.abort(),
			onPayload: (value) => {
				payload = value as BedrockThinkingPayload;
				return value;
			},
		});
		await stream.result();

		expect(payload?.inferenceConfig?.maxTokens).toBe(4096);
		expect(payload?.additionalModelRequestFields?.thinking).toMatchObject({
			type: "enabled",
			budget_tokens: 3072,
		});
		expect(payload?.additionalModelRequestFields?.thinking?.budget_tokens).toBeLessThan(
			payload?.inferenceConfig?.maxTokens ?? 0,
		);
		expect(payload?.inferenceConfig?.temperature).toBeUndefined();
	});

	it.each([
		["budget below the provider minimum", { control: "budget", levels: { high: 1023 } }, "at least 1024"],
		[
			"synthetic numeric off budget",
			{ control: "budget", levels: { off: 0, high: 1024 } },
			'budget level "off" is structural',
		],
		["infinite budget", { control: "budget", levels: { high: Number.POSITIVE_INFINITY } }, "finite integer"],
		["numeric effort", { control: "effort", levels: { high: 8192 } }, "must use a non-empty string"],
	] as const)("rejects an invalid Bedrock %s before payload construction", async (_name, contract, message) => {
		let payloadBuilt = false;
		const model: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
			reasoningCapabilities: contract as unknown as ModelReasoningCapabilities,
		};
		const result = await streamBedrock(model, makeContext(), {
			reasoning: "high",
			onPayload: () => {
				payloadBuilt = true;
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(message);
		expect(payloadBuilt).toBe(false);
	});

	it("serializes exact custom Claude and Nova effort contracts through their native Bedrock fields", async () => {
		const claude: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1"),
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opaque-claude",
			name: "Custom Claude Adaptive Route",
			reasoningCapabilities: { control: "effort", levels: { high: "turbo" } },
		};
		const claudePayload = await captureSimplePayload(claude, { reasoning: "high" });
		expect(claudePayload.additionalModelRequestFields?.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
		});
		expect(claudePayload.additionalModelRequestFields?.output_config).toEqual({ effort: "turbo" });

		const nova: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "amazon.nova-2-lite-v1:0"),
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opaque-nova",
			name: "Custom Nova 2 Lite Route",
			reasoningCapabilities: { control: "effort", levels: { high: "medium" } },
		};
		const novaPayload = await captureSimplePayload(nova, { reasoning: "high" });
		expect(novaPayload.additionalModelRequestFields?.reasoningConfig).toEqual({
			type: "enabled",
			maxReasoningEffort: "medium",
		});
	});

	it("rejects an exact Bedrock effort contract when the route has no native effort mechanism", async () => {
		let payloadBuilt = false;
		const model: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "deepseek.r1-v1:0"),
			id: "opaque-effort-route",
			name: "Opaque Effort Route",
			reasoningCapabilities: { control: "effort", levels: { high: "high" } },
		};
		const result = await streamSimpleBedrock(model, makeContext(), {
			reasoning: "high",
			onPayload: () => {
				payloadBuilt = true;
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Bedrock effort contracts require a Claude adaptive-thinking route");
		expect(payloadBuilt).toBe(false);
	});

	it("retains temperature when optional Claude thinking is omitted or disabled", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

		for (const reasoning of [undefined, "off" as const]) {
			const payload = await captureSimplePayload(model, { reasoning, temperature: 0.5 });
			expect(payload.inferenceConfig?.temperature).toBe(0.5);
			expect(payload.additionalModelRequestFields).toBeUndefined();
		}
	});

	it("uses adaptive thinking for Claude Opus 4.7 when reasoning is enabled", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-7-v1",
			name: "Claude Opus 4.7 (Global)",
		};

		const payload = await capturePayload(model, { temperature: 0.5 });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
		expect(payload.inferenceConfig?.temperature).toBeUndefined();
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.7", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-7");

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});

	it("clamps xhigh reasoning to effort=max for Claude Opus 4.6 (no native xhigh)", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "max" });
	});

	it("maps max reasoning to effort=max for Claude Opus 4.6 (adaptive)", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");

		const payload = await capturePayload(model, { reasoning: "max" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "max" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});

	it("uses adaptive thinking with effort for Claude Fable 5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5");

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
	});

	it.each(["global.anthropic.claude-fable-5", "global.anthropic.claude-opus-5-5"])(
		"drops temperature for always-on %s without a reasoning selection",
		async (id) => {
			const model: Model<"bedrock-converse-stream"> = {
				...getModel("amazon-bedrock", "global.anthropic.claude-opus-5"),
				id,
				name: id,
			};

			let payload: BedrockThinkingPayload | undefined;
			await streamBedrock(model, makeContext(), {
				temperature: 0.5,
				signal: AbortSignal.abort(),
				onPayload: (value) => {
					payload = value as BedrockThinkingPayload;
					return value;
				},
			}).result();

			expect(payload).toBeDefined();
			expect(payload?.inferenceConfig?.temperature).toBeUndefined();
		},
	);

	it("keeps temperature and omits thinking when a Fable-named model is non-reasoning", async () => {
		const model: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "global.anthropic.claude-fable-5"),
			reasoning: false,
		};
		let payload: BedrockThinkingPayload | undefined;
		const stream = streamSimpleBedrock(model, makeContext(), {
			reasoning: "high",
			temperature: 0.5,
			signal: AbortSignal.abort(),
			onPayload: (value) => {
				payload = value as BedrockThinkingPayload;
				return value;
			},
		});

		await stream.result();

		expect(payload?.inferenceConfig?.temperature).toBe(0.5);
		expect(payload?.additionalModelRequestFields).toBeUndefined();
	});

	it("omits display for GovCloud model ids on non-adaptive Claude thinking", async () => {
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
			name: "Claude Sonnet 4.5 (GovCloud)",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
	});

	it("omits display for GovCloud regions on adaptive Claude thinking", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-7-v1",
			name: "Claude Opus 4.7 (Global)",
		};

		const payload = await capturePayload(model, { region: "us-gov-west-1" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});
});

describe("Application inference profile support", () => {
	it("uses adaptive thinking when model.name contains the model name but ARN does not", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Opus 4.6",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
	});

	it("injects cache points when model.name identifies a supported Claude model", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Sonnet 4.6",
		};

		let capturedPayload: any;
		const s = streamBedrock(
			model,
			{
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			},
			{
				signal: AbortSignal.abort(),
				onPayload: (payload) => {
					capturedPayload = payload;
					return payload;
				},
			},
		);

		for await (const event of s) {
			if (event.type === "error") break;
		}

		expect(capturedPayload.system).toHaveLength(2);
		expect(capturedPayload.system[1]).toHaveProperty("cachePoint");

		const lastMsg = capturedPayload.messages[capturedPayload.messages.length - 1];
		const lastContent = lastMsg.content[lastMsg.content.length - 1];
		expect(lastContent).toHaveProperty("cachePoint");
	});

	it("falls back to fixed-budget thinking for non-adaptive Claude via model.name", async () => {
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Sonnet 4.5",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "enabled",
			budget_tokens: expect.any(Number),
		});
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
	});
});

describe("Bedrock endpoint resolution", () => {
	const awsEnvVars = ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"] as const;
	const originalEnv = Object.fromEntries(awsEnvVars.map((name) => [name, process.env[name]]));

	beforeEach(() => {
		bedrockMock.constructorCalls.length = 0;
		for (const name of awsEnvVars) delete process.env[name];
	});

	afterEach(() => {
		for (const name of awsEnvVars) {
			const value = originalEnv[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("assigns eu-central-1 runtime URLs to built-in EU inference profiles", () => {
		expect(getModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0").baseUrl).toBe(
			"https://bedrock-runtime.eu-central-1.amazonaws.com",
		);
	});

	it.each([
		{
			name: "does not pin standard AWS endpoints when AWS_REGION is configured",
			env: "us-east-2",
			modelId: "us.anthropic.claude-opus-4-7" as const,
			baseUrl: undefined,
			endpoint: undefined,
			region: "us-east-2",
		},
		{
			name: "derives the region from a built-in EU endpoint when nothing is configured",
			env: undefined,
			modelId: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0" as const,
			baseUrl: undefined,
			endpoint: "https://bedrock-runtime.eu-central-1.amazonaws.com",
			region: "eu-central-1",
		},
		{
			name: "passes custom Bedrock endpoints through to the SDK client",
			env: "us-west-2",
			modelId: "us.anthropic.claude-opus-4-7" as const,
			baseUrl: "https://bedrock-vpc.example.com",
			endpoint: "https://bedrock-vpc.example.com",
			region: "us-west-2",
		},
	])("$name", async ({ env, modelId, baseUrl, endpoint, region }) => {
		if (env) process.env.AWS_REGION = env;
		const baseModel = getModel("amazon-bedrock", modelId);
		const model: Model<"bedrock-converse-stream"> = baseUrl ? { ...baseModel, baseUrl } : baseModel;

		await streamBedrock(model, makeContext(), { cacheRetention: "none" }).result();

		expect(bedrockMock.constructorCalls).toHaveLength(1);
		expect(bedrockMock.constructorCalls[0].endpoint).toBe(endpoint);
		expect(bedrockMock.constructorCalls[0].region).toBe(region);
	});
});
