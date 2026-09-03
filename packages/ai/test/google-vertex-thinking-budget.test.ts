import type * as GoogleGenAi from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof GoogleGenAi>();
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield {
					candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
				};
			},
		};
	}

	return {
		...actual,
		GoogleGenAI,
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { getModel, getReasoningCapabilities, getSupportedThinkingLevels } from "../src/models.js";
import { streamGoogle, streamSimpleGoogle } from "../src/providers/google.js";
import { streamGoogleVertex, streamSimpleGoogleVertex } from "../src/providers/google-vertex.js";
import type { Context, Model, ModelReasoningCapabilities } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const stableFlashLite = getModel("google-vertex", "gemini-2.5-flash-lite");
const flashLiteModels = [stableFlashLite, { ...stableFlashLite, id: "gemini-2.5-flash-lite-preview" }] as const;

async function captureReasoningPayload(
	model: Model<"google-vertex">,
	reasoning: "off" | "minimal" | "low" | "medium" | "high" = "minimal",
): Promise<GenerateContentParameters> {
	let capturedPayload: GenerateContentParameters | undefined;
	const stream = streamSimpleGoogleVertex(model, context, {
		apiKey: "fake-key",
		reasoning,
		onPayload: (payload) => {
			capturedPayload = payload as GenerateContentParameters;
			return payload;
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected Vertex payload to be captured");
	}
	return capturedPayload;
}

async function captureDefaultReasoningPayload(): Promise<GenerateContentParameters> {
	let capturedPayload: GenerateContentParameters | undefined;
	const stream = streamSimpleGoogleVertex(stableFlashLite, context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as GenerateContentParameters;
			return payload;
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected Vertex payload to be captured");
	return capturedPayload;
}

async function captureDirectReasoningPayload(
	model: Model<"google-generative-ai">,
	reasoning: "off" | "minimal" | "low" | "medium" | "high",
): Promise<GenerateContentParameters> {
	let capturedPayload: GenerateContentParameters | undefined;
	const stream = streamSimpleGoogle(model, context, {
		apiKey: "fake-key",
		reasoning,
		onPayload: (payload) => {
			capturedPayload = payload as GenerateContentParameters;
			return payload;
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected Google payload to be captured");
	return capturedPayload;
}

async function captureDirectGoogleDisablePayload(
	model: Model<"google-generative-ai">,
): Promise<GenerateContentParameters> {
	let capturedPayload: GenerateContentParameters | undefined;
	const stream = streamGoogle(model, context, {
		apiKey: "fake-key",
		thinking: { enabled: false },
		onPayload: (payload) => {
			capturedPayload = payload as GenerateContentParameters;
			return payload;
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected direct Google payload to be captured");
	return capturedPayload;
}

async function captureDirectVertexDisablePayload(model: Model<"google-vertex">): Promise<GenerateContentParameters> {
	let capturedPayload: GenerateContentParameters | undefined;
	const stream = streamGoogleVertex(model, context, {
		apiKey: "fake-key",
		thinking: { enabled: false },
		onPayload: (payload) => {
			capturedPayload = payload as GenerateContentParameters;
			return payload;
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected direct Vertex payload to be captured");
	return capturedPayload;
}

const gemini37Levels = {
	off: null,
	minimal: null,
	low: "LOW",
	medium: "MEDIUM",
	high: "HIGH",
	xhigh: null,
	max: null,
} as const;

describe("Google Vertex thinking budget payload", () => {
	it.each(flashLiteModels)("uses the supported minimal budget for $id", async (model) => {
		const payload = await captureReasoningPayload(model);

		expect(payload.config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 512,
		});
	});

	it("preserves the provider thinking default when reasoning is omitted", async () => {
		const payload = await captureDefaultReasoningPayload();
		expect(payload.config?.thinkingConfig).toBeUndefined();

		const fixedModel: Model<"google-vertex"> = {
			...stableFlashLite,
			reasoningCapabilities: { control: "fixed", levels: { high: "always" } },
			thinkingLevelMap: { high: "always" },
		};
		const fixedPayload = await captureReasoningPayload(fixedModel);
		expect(fixedPayload.config?.thinkingConfig).toBeUndefined();

		const gemini3Payload = await captureReasoningPayload(getModel("google-vertex", "gemini-3-pro-preview"), "medium");
		expect(gemini3Payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
		const gemini31Payload = await captureReasoningPayload(
			getModel("google-vertex", "gemini-3.1-pro-preview"),
			"medium",
		);
		expect(gemini31Payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" });
	});

	it("serializes current Flash aliases and Gemini 3.7 through named thinking levels", async () => {
		const flashPayload = await captureDirectReasoningPayload(getModel("google", "gemini-flash-latest"), "low");
		expect(flashPayload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });

		const flashMinimalFallback = await captureDirectReasoningPayload(
			getModel("google", "gemini-flash-latest"),
			"minimal",
		);
		expect(flashMinimalFallback.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });

		const flashLitePayload = await captureDirectReasoningPayload(
			getModel("google", "gemini-flash-lite-latest"),
			"minimal",
		);
		expect(flashLitePayload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "MINIMAL" });

		const direct37: Model<"google-generative-ai"> = {
			...getModel("google", "gemini-3.5-flash"),
			id: "gemini-3.7-flash",
			thinkingLevelMap: { ...gemini37Levels },
			reasoningCapabilities: { control: "effort", levels: { ...gemini37Levels } },
		};
		const vertex37: Model<"google-vertex"> = {
			...getModel("google-vertex", "gemini-3-flash-preview"),
			id: "gemini-3.7-flash-preview",
			thinkingLevelMap: { ...gemini37Levels },
			reasoningCapabilities: { control: "effort", levels: { ...gemini37Levels } },
		};

		expect(await captureDirectReasoningPayload(direct37, "minimal")).toMatchObject({
			config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" } },
		});
		expect(await captureReasoningPayload(vertex37, "medium")).toMatchObject({
			config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" } },
		});
	});

	it("keeps numeric automatic-thinking maps as budget controls", async () => {
		const direct: Model<"google-generative-ai"> = {
			...getModel("google", "gemini-2.5-flash"),
			id: "gemini-robotics-er-2-preview",
			reasoningCapabilities: { control: "budget", levels: { off: 0, high: -1 } },
		};
		const vertex = getModel("google-vertex", "gemini-2.0-flash-lite");

		expect(direct.reasoningCapabilities).toEqual({ control: "budget", levels: { off: 0, high: -1 } });
		expect(vertex.reasoningCapabilities).toEqual({ control: "budget", levels: { off: 0, high: -1 } });
		expect((await captureDirectReasoningPayload(direct, "high")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: -1,
		});
		expect((await captureReasoningPayload(vertex, "off")).config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
	});

	it("translates direct disable through each model's exact off contract", async () => {
		const directMandatory = getModel("google", "gemini-3.1-pro-preview");
		const directPayload = await captureDirectGoogleDisablePayload(directMandatory);
		expect(directPayload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
		expect((await captureDirectReasoningPayload(directMandatory, "off")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "LOW",
		});

		const vertexMandatory = getModel("google-vertex", "gemini-2.5-pro");
		const vertexPayload = await captureDirectVertexDisablePayload(vertexMandatory);
		expect(vertexPayload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 128 });
		expect((await captureReasoningPayload(vertexMandatory, "off")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 128,
		});

		expect(
			(await captureDirectGoogleDisablePayload(getModel("google", "gemini-2.5-flash"))).config?.thinkingConfig,
		).toEqual({ thinkingBudget: 0 });
		expect(
			(await captureDirectVertexDisablePayload(getModel("google-vertex", "gemini-2.5-flash"))).config
				?.thinkingConfig,
		).toEqual({ thinkingBudget: 0 });
	});

	it.each([
		["Gemini 2.5 Pro zero", "gemini-2.5-pro", 0, "thinking cannot be disabled"],
		["Gemini 2.5 Pro below-range", "gemini-2.5-pro", 127, "between 128 and 32768"],
		["Gemini 2.5 Flash-Lite below-range", "gemini-2.5-flash-lite", 511, "between 512 and 24576"],
		["Gemini 2.5 Flash above-range", "gemini-2.5-flash", 24577, "between 1 and 24576"],
	] as const)("rejects an invalid %s budget before payload construction", async (_name, modelId, budget, message) => {
		let payloadBuilt = false;
		const base = getModel("google", modelId);
		const model: Model<"google-generative-ai"> = {
			...base,
			reasoningCapabilities: {
				control: "budget",
				levels: { high: budget },
			} as unknown as ModelReasoningCapabilities,
		};
		const result = await streamGoogle(model, context, {
			apiKey: "fake-key",
			thinking: { enabled: true },
			onPayload: () => {
				payloadBuilt = true;
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(message);
		expect(payloadBuilt).toBe(false);
	});

	it.each([
		["positive budget", 128, 'budget level "off" must disable reasoning'],
		["dynamic sentinel", -1, "the -1 sentinel enables dynamic thinking"],
	] as const)("rejects %s in a Google off mapping before payload construction", async (_name, off, message) => {
		let payloadBuilt = false;
		const model: Model<"google-generative-ai"> = {
			...getModel("google", "gemini-2.5-flash"),
			reasoningCapabilities: {
				control: "budget",
				levels: { off, high: 24576 },
			},
		};
		const result = await streamGoogle(model, context, {
			apiKey: "fake-key",
			thinking: { enabled: false },
			onPayload: () => {
				payloadBuilt = true;
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(message);
		expect(payloadBuilt).toBe(false);
	});

	it("rejects the Google dynamic sentinel in a direct disabled request", async () => {
		let payloadBuilt = false;
		const result = await streamGoogle(getModel("google", "gemini-2.5-flash"), context, {
			apiKey: "fake-key",
			thinking: { enabled: false, budgetTokens: -1 },
			onPayload: () => {
				payloadBuilt = true;
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("the -1 sentinel enables dynamic thinking");
		expect(payloadBuilt).toBe(false);
	});

	it("rejects request fields that do not match an exact Google control type", async () => {
		let directPayloadBuilt = false;
		const directResult = await streamGoogle(getModel("google", "gemini-3.1-pro-preview"), context, {
			apiKey: "fake-key",
			thinking: { enabled: true, budgetTokens: 1024 },
			onPayload: () => {
				directPayloadBuilt = true;
			},
		}).result();
		expect(directResult.stopReason).toBe("error");
		expect(directResult.errorMessage).toContain("an effort control cannot serialize a numeric thinking budget");
		expect(directPayloadBuilt).toBe(false);

		let vertexPayloadBuilt = false;
		const vertexResult = await streamGoogleVertex(getModel("google-vertex", "gemini-2.5-flash"), context, {
			apiKey: "fake-key",
			thinking: { enabled: true, level: "LOW" },
			onPayload: () => {
				vertexPayloadBuilt = true;
			},
		}).result();
		expect(vertexResult.stopReason).toBe("error");
		expect(vertexResult.errorMessage).toContain("a budget control cannot serialize a named thinking level");
		expect(vertexPayloadBuilt).toBe(false);
	});

	it("fills missing legacy Google map entries with native named levels", async () => {
		const named = getModel("google", "gemini-3-flash-preview");
		const partial: Model<"google-generative-ai"> = {
			...named,
			reasoningCapabilities: undefined,
			thinkingLevelMap: { high: "CUSTOM_HIGH" },
		};

		expect(getReasoningCapabilities(partial)).toEqual({
			control: "effort",
			levels: {
				off: null,
				minimal: "MINIMAL",
				low: "LOW",
				medium: "MEDIUM",
				high: "CUSTOM_HIGH",
				xhigh: null,
				max: null,
			},
		});
		expect((await captureDirectReasoningPayload(partial, "low")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "LOW",
		});
		expect((await captureDirectReasoningPayload(partial, "high")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "CUSTOM_HIGH",
		});

		const vertexPartial: Model<"google-vertex"> = {
			...getModel("google-vertex", "gemini-3.1-pro-preview"),
			reasoningCapabilities: undefined,
			thinkingLevelMap: { high: "HIGH" },
		};
		expect(getReasoningCapabilities(vertexPartial)?.levels.low).toBe("LOW");
		expect(getReasoningCapabilities(vertexPartial)?.levels.medium).toBe("MEDIUM");
		expect((await captureReasoningPayload(vertexPartial, "low")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "LOW",
		});
		expect((await captureReasoningPayload(vertexPartial, "medium")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "MEDIUM",
		});
	});

	it("fills missing legacy Google map entries with numeric budgets", async () => {
		const budget = getModel("google", "gemini-2.5-flash");
		const partial: Model<"google-generative-ai"> = {
			...budget,
			reasoningCapabilities: undefined,
			thinkingLevelMap: { high: "HIGH" },
		};

		expect(getReasoningCapabilities(partial)).toEqual({
			control: "budget",
			levels: {
				off: 0,
				minimal: 128,
				low: 2048,
				medium: 8192,
				high: 24576,
				xhigh: null,
				max: null,
			},
		});
		expect((await captureDirectReasoningPayload(partial, "low")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 2048,
		});
		expect((await captureDirectReasoningPayload(partial, "high")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 24576,
		});

		const vertexPartial: Model<"google-vertex"> = {
			...getModel("google-vertex", "gemini-2.5-flash-lite"),
			reasoningCapabilities: undefined,
			thinkingLevelMap: { high: "HIGH" },
		};
		expect(getReasoningCapabilities(vertexPartial)?.levels.minimal).toBe(512);
		expect((await captureReasoningPayload(vertexPartial, "minimal")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 512,
		});
	});

	it("leaves an exact Google reasoningCapabilities contract unfilled", async () => {
		const exact: Model<"google-generative-ai"> = {
			...getModel("google", "gemini-3-flash-preview"),
			reasoningCapabilities: { control: "effort", levels: { high: "HIGH" } },
			thinkingLevelMap: { high: "HIGH" },
		};

		expect(getReasoningCapabilities(exact)).toEqual({ control: "effort", levels: { high: "HIGH" } });
		expect(getSupportedThinkingLevels(exact)).toEqual(["high"]);
		expect((await captureDirectReasoningPayload(exact, "low")).config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "HIGH",
		});
	});
});
