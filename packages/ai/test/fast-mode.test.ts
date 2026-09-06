import { describe, expect, it } from "vitest";
import { defaultServiceTierForModel, supportsFastMode } from "../src/models.js";
import { buildBaseOptions } from "../src/providers/simple-options.js";
import type { Api, Model } from "../src/types.js";

function model(provider: string, id: string, api: Api): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("Fast mode", () => {
	it.each(["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-6-astra"])("supports %s through ChatGPT auth", (id) => {
		expect(supportsFastMode(model("openai-codex", id, "openai-codex-responses"))).toBe(true);
	});

	it("rejects unsupported models and non-OpenAI gateways", () => {
		expect(supportsFastMode(model("openai-codex", "gpt-5.3-codex", "openai-codex-responses"))).toBe(false);
		expect(supportsFastMode(model("openai-codex", "gpt-5.4-mini", "openai-codex-responses"))).toBe(false);
		expect(supportsFastMode(model("openai", "gpt-5.1", "openai-responses"))).toBe(false);
		expect(supportsFastMode(model("github-copilot", "gpt-5.5", "openai-responses"))).toBe(false);
	});

	it("admits API-key models and forwards priority", () => {
		const testModel = model("openai", "gpt-5.5", "openai-responses");
		expect(supportsFastMode(testModel)).toBe(true);
		expect(buildBaseOptions(testModel, { serviceTier: "priority" }).serviceTier).toBe("priority");
	});

	it("forwards priority through simple stream options", () => {
		const testModel = model("openai-codex", "gpt-5.5", "openai-codex-responses");
		expect(buildBaseOptions(testModel, { serviceTier: "priority" }).serviceTier).toBe("priority");
	});

	it.each(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-astra"])(
		"defaults ChatGPT-auth %s to priority",
		(id) => {
			expect(defaultServiceTierForModel(model("openai-codex", id, "openai-codex-responses"))).toBe("priority");
		},
	);

	it("defaults native API Astra to fast and forwards an explicit off preference", () => {
		const astra = model("openai", "gpt-6-astra", "openai-responses");
		expect(supportsFastMode(astra)).toBe(true);
		expect(defaultServiceTierForModel(astra)).toBe("priority");
		expect(buildBaseOptions(astra, { serviceTier: "default" }).serviceTier).toBe("default");
		expect(defaultServiceTierForModel(model("openrouter", "gpt-6-astra", "openai-completions"))).toBe("default");
	});

	it("keeps Astra standard on the EU API data-residency endpoint", () => {
		const astra = { ...model("openai", "gpt-6-astra", "openai-responses"), baseUrl: "https://eu.api.openai.com/v1" };
		expect(supportsFastMode(astra)).toBe(false);
		expect(defaultServiceTierForModel(astra)).toBe("default");
	});

	it("does not default API-key GPT or Grok models to priority", () => {
		expect(defaultServiceTierForModel(model("openai", "gpt-5.5", "openai-responses"))).toBe("default");
		expect(defaultServiceTierForModel(model("openai-codex", "gpt-5.3-codex", "openai-codex-responses"))).toBe(
			"default",
		);
		expect(defaultServiceTierForModel(model("grok", "grok-4.5", "grok-responses"))).toBe("default");
		expect(defaultServiceTierForModel(undefined)).toBe("default");
	});
});
