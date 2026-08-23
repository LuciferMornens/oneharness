import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { clampThinkingLevel, getModel, getModels, getSupportedThinkingLevels } from "../src/models.js";

const originalAudnApiKey = process.env.AUDN_API_KEY;

afterEach(() => {
	if (originalAudnApiKey === undefined) {
		delete process.env.AUDN_API_KEY;
	} else {
		process.env.AUDN_API_KEY = originalAudnApiKey;
	}
});

describe("audn.ai models", () => {
	it("registers Necromicon with a 1M context window and Kimi K3 reasoning effort", () => {
		const model = getModel("audn", "necromicon");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("audn");
		expect(model.baseUrl).toBe("https://platform.audn.ai/api/v1");
		expect(model.name).toBe("Necromicon");
		expect(model.reasoning).toBe(true);
		expect(model.reasoningCapabilities).toEqual({
			control: "effort",
			levels: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "high", "max"]);
		expect(clampThinkingLevel(model, "medium")).toBe("high");
		expect(clampThinkingLevel(model, "max")).toBe("max");
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(8192);
		expect(model.featured).toBe(true);
		expect(model.cost).toEqual({
			input: 4,
			output: 21,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: true,
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			requiresReasoningContentOnAssistantMessages: true,
		});
	});

	it("registers Pingu Unchained 10 as the non-reasoning function-calling model", () => {
		const model = getModel("audn", "pingu-unchained-10");

		expect(model).toBeDefined();
		expect(model.reasoning).toBe(false);
		expect(model.reasoningCapabilities).toBeUndefined();
		expect(model.contextWindow).toBe(262144);
		expect(model.maxTokens).toBe(16384);
		expect(model.cost).toEqual({
			input: 2,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(model.compat).toMatchObject({
			maxTokensField: "max_tokens",
			supportsReasoningEffort: false,
		});
		expect(model.compat?.requiresReasoningContentOnAssistantMessages).toBeUndefined();
	});

	it("registers the rest of the audn.ai roster", () => {
		const ids = getModels("audn")
			.map((model) => model.id)
			.sort();
		expect(ids).toEqual([
			"godzilla",
			"k3-thinker-qwen38",
			"kong",
			"necromicon",
			"pingu-unchained-10",
			"stealth-ox-alpha",
		]);

		expect(getModel("audn", "kong").contextWindow).toBe(262144);
		expect(getModel("audn", "godzilla").contextWindow).toBe(131072);
		expect(getModel("audn", "stealth-ox-alpha").contextWindow).toBe(1000000);
		expect(getModel("audn", "k3-thinker-qwen38").reasoningCapabilities).toEqual({
			control: "effort",
			levels: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		});
	});

	it("resolves AUDN_API_KEY from the environment", () => {
		process.env.AUDN_API_KEY = "sk_live_test-audn-key";

		expect(findEnvKeys("audn")).toEqual(["AUDN_API_KEY"]);
		expect(getEnvApiKey("audn")).toBe("sk_live_test-audn-key");
	});
});
