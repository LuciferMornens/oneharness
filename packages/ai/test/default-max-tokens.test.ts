import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { buildBaseOptions, resolveDefaultMaxTokens } from "../src/providers/simple-options.js";
import type { Model } from "../src/types.js";

describe("default max output tokens", () => {
	it("gives Claude Fable 5.1 its full 128k output limit", () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		expect(model.maxTokens).toBe(128000);
		expect(resolveDefaultMaxTokens(model)).toBe(128000);
		expect(buildBaseOptions(model).maxTokens).toBe(128000);
	});

	it("gives GPT-6 Astra its full 128k output limit on the OpenAI and Codex routes", () => {
		for (const provider of ["openai", "openai-codex"] as const) {
			const model = getModel(provider, "gpt-6-astra");
			expect(model.maxTokens).toBe(128000);
			expect(resolveDefaultMaxTokens(model)).toBe(128000);
		}
	});

	it("keeps the 32k default for other large-output models", () => {
		const opus = getModel("anthropic", "claude-opus-4-6");
		expect(opus.maxTokens).toBeGreaterThan(32000);
		expect(resolveDefaultMaxTokens(opus)).toBe(32000);
		const gpt5 = getModel("openai", "gpt-5.4");
		expect(gpt5.maxTokens).toBeGreaterThan(32000);
		expect(resolveDefaultMaxTokens(gpt5)).toBe(32000);
	});

	it("never exceeds a model's own output limit", () => {
		const haiku = getModel("anthropic", "claude-haiku-4-5");
		expect(resolveDefaultMaxTokens(haiku)).toBe(Math.min(haiku.maxTokens, 32000));
		const unknown = { ...haiku, maxTokens: 0 } as Model<"anthropic-messages">;
		expect(resolveDefaultMaxTokens(unknown)).toBeUndefined();
	});

	it("prefers an explicit maxTokens option", () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		expect(buildBaseOptions(model, { maxTokens: 4096 }).maxTokens).toBe(4096);
	});
});
