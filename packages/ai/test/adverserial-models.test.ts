import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { clampThinkingLevel, getModel, getModels, getSupportedThinkingLevels } from "../src/models.js";

const originalAdverserialApiKey = process.env.ADVERSERIAL_API_KEY;

afterEach(() => {
	if (originalAdverserialApiKey === undefined) {
		delete process.env.ADVERSERIAL_API_KEY;
	} else {
		process.env.ADVERSERIAL_API_KEY = originalAdverserialApiKey;
	}
});

describe("adverserial.ai models", () => {
	it("registers CyberKimi with a 750K context window and full reasoning effort range", () => {
		const model = getModel("adverserial", "lordx64/cyberkimi");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("adverserial");
		expect(model.baseUrl).toBe("https://api.adverserial.ai/v1");
		expect(model.name).toBe("CyberKimi");
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
				max: "max",
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(clampThinkingLevel(model, "medium")).toBe("medium");
		expect(clampThinkingLevel(model, "max")).toBe("max");
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(750000);
		expect(model.maxTokens).toBe(131072);
		expect(model.featured).toBe(true);
		expect(model.cost).toEqual({
			input: 8,
			output: 30,
			cacheRead: 0.8,
			cacheWrite: 0,
		});
		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			requiresReasoningContentOnAssistantMessages: true,
		});
	});

	it("registers CyberGLM as the 131K budget tier", () => {
		const model = getModel("adverserial", "lordx64/cyberglm");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("adverserial");
		expect(model.baseUrl).toBe("https://api.adverserial.ai/v1");
		expect(model.name).toBe("CyberGLM");
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
				max: "max",
			},
		});
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(131072);
		expect(model.maxTokens).toBe(32768);
		expect(model.featured).toBeUndefined();
		expect(model.cost).toEqual({
			input: 4,
			output: 15,
			cacheRead: 0.8,
			cacheWrite: 0,
		});
	});

	it("registers the adverserial.ai roster", () => {
		const ids = getModels("adverserial")
			.map((model) => model.id)
			.sort();
		expect(ids).toEqual(["lordx64/cyberglm", "lordx64/cyberkimi"]);
	});

	it("resolves ADVERSERIAL_API_KEY from the environment", () => {
		process.env.ADVERSERIAL_API_KEY = "sk_test-adverserial-key";

		expect(findEnvKeys("adverserial")).toEqual(["ADVERSERIAL_API_KEY"]);
		expect(getEnvApiKey("adverserial")).toBe("sk_test-adverserial-key");
	});
});
