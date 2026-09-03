import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { clampThinkingLevel, getModel, getModels, getSupportedThinkingLevels } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

const mockState = vi.hoisted(() => ({ lastParams: undefined as unknown, lastClientOptions: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: (params: unknown) => {
				mockState.lastParams = params;
				const stream = {
					async *[Symbol.asyncIterator]() {},
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
		};
		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}
	}
	return { default: FakeOpenAI };
});

const context = { messages: [{ role: "user" as const, content: "Hi", timestamp: 0 }] };

async function responsesPayload(
	modelId: string,
	reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
) {
	let captured: unknown;
	await streamSimple(getModel("abliteration", modelId as never), context, {
		apiKey: "test",
		...(reasoning !== undefined ? { reasoning } : {}),
		onPayload: (value) => {
			captured = value;
		},
	}).result();
	return captured as Record<string, unknown>;
}

const originalKey = process.env.ABLITERATION_API_KEY;

afterEach(() => {
	if (originalKey === undefined) {
		delete process.env.ABLITERATION_API_KEY;
	} else {
		process.env.ABLITERATION_API_KEY = originalKey;
	}
});

describe("abliteration.ai models", () => {
	it("registers abliterated-model-large-v2 with 1M context and low/high/max effort", () => {
		const model = getModel("abliteration", "abliterated-model-large-v2");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-responses");
		expect(model.provider).toBe("abliteration");
		expect(model.baseUrl).toBe("https://api.abliteration.ai/v1");
		expect(model.name).toBe("Abliterated Model Large V2");
		expect(model.reasoning).toBe(true);
		expect(model.reasoningCapabilities).toEqual({
			control: "effort",
			levels: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "max",
				max: "max",
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(clampThinkingLevel(model, "medium")).toBe("medium");
		expect(clampThinkingLevel(model, "minimal")).toBe("minimal");
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(999990);
		expect(model.featured).toBe(true);
		expect(model.cost).toEqual({
			input: 5,
			output: 5,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
	});

	it("registers abliterated-model-large with high/max native modes", () => {
		const model = getModel("abliteration", "abliterated-model-large");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-responses");
		expect(model.reasoning).toBe(true);
		expect(model.reasoningCapabilities).toEqual({
			control: "effort",
			levels: {
				off: "none",
				minimal: "high",
				low: "high",
				medium: "high",
				high: "high",
				xhigh: "max",
				max: "max",
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(999990);
		expect(model.cost).toEqual({
			input: 5,
			output: 5,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
	});

	it("registers abliterated-model without max on Responses and with image input", () => {
		const model = getModel("abliteration", "abliterated-model");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-responses");
		expect(model.reasoning).toBe(true);
		expect(model.reasoningCapabilities).toEqual({
			control: "effort",
			levels: {
				off: "none",
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(262144);
		expect(model.maxTokens).toBe(262134);
		expect(model.cost).toEqual({
			input: 3,
			output: 3,
			cacheRead: 0.3,
			cacheWrite: 0,
		});
	});

	it("registers the full abliteration.ai roster", () => {
		const ids = getModels("abliteration")
			.map((model) => model.id)
			.sort();
		expect(ids).toEqual(["abliterated-model", "abliterated-model-large", "abliterated-model-large-v2"]);
	});

	it("resolves ABLITERATION_API_KEY from the environment", () => {
		process.env.ABLITERATION_API_KEY = "ak_test-abliteration-key";

		expect(findEnvKeys("abliteration")).toEqual(["ABLITERATION_API_KEY"]);
		expect(getEnvApiKey("abliteration")).toBe("ak_test-abliteration-key");
	});

	describe("responses request payloads", () => {
		beforeEach(() => {
			mockState.lastParams = undefined;
			mockState.lastClientOptions = undefined;
		});

		it("targets the abliteration base URL", async () => {
			await responsesPayload("abliterated-model-large-v2", "max");
			expect((mockState.lastClientOptions as { baseURL?: string }).baseURL).toBe("https://api.abliteration.ai/v1");
		});

		it("sends model id with stream:true like the reference curl", async () => {
			const params = await responsesPayload("abliterated-model-large-v2", "max");
			expect(params).toMatchObject({
				model: "abliterated-model-large-v2",
				stream: true,
				reasoning: { effort: "max" },
			});
		});

		it("maps medium to high on large-v2 (three native modes)", async () => {
			const params = await responsesPayload("abliterated-model-large-v2", "medium");
			expect(params).toMatchObject({ reasoning: { effort: "high" } });
		});

		it("maps minimal to low on large-v2", async () => {
			const params = await responsesPayload("abliterated-model-large-v2", "minimal");
			expect(params).toMatchObject({ reasoning: { effort: "low" } });
		});

		it("sends none when reasoning is off", async () => {
			const params = await responsesPayload("abliterated-model-large-v2", "off");
			expect(params).toMatchObject({ reasoning: { effort: "none" } });
		});

		it("maps medium to high on large (two native modes)", async () => {
			const params = await responsesPayload("abliterated-model-large", "medium");
			expect(params).toMatchObject({ reasoning: { effort: "high" } });
		});

		it("sends distinct levels straight through on the base model", async () => {
			const params = await responsesPayload("abliterated-model", "high");
			expect(params).toMatchObject({ reasoning: { effort: "high" } });
		});
	});
});
