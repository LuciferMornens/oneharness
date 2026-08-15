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
	it.each(["gpt-5.4", "gpt-5.5", "gpt-5.6-luna"])("supports %s through ChatGPT auth", (id) => {
		expect(supportsFastMode(model("openai-codex", id, "openai-codex-responses"))).toBe(true);
	});

	it("rejects unsupported models and API-key providers", () => {
		expect(supportsFastMode(model("openai-codex", "gpt-5.3-codex", "openai-codex-responses"))).toBe(false);
		expect(supportsFastMode(model("openai-codex", "gpt-5.4-mini", "openai-codex-responses"))).toBe(false);
		expect(supportsFastMode(model("openai", "gpt-5.5", "openai-responses"))).toBe(false);
	});

	it("forwards priority through simple stream options", () => {
		const testModel = model("openai-codex", "gpt-5.5", "openai-codex-responses");
		expect(buildBaseOptions(testModel, { serviceTier: "priority" }).serviceTier).toBe("priority");
	});

	it.each(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-luna"])("defaults ChatGPT-auth %s to priority", (id) => {
		expect(defaultServiceTierForModel(model("openai-codex", id, "openai-codex-responses"))).toBe("priority");
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
