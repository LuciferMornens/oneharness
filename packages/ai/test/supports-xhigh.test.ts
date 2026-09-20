import { describe, expect, it } from "vitest";
import {
	getModel,
	getModels,
	getProviders,
	getReasoningCapabilities,
	getSupportedThinkingLevels,
} from "../src/models.js";

describe("getSupportedThinkingLevels", () => {
	it("exposes native DeepSeek V4 efforts on the DeepSeek provider", () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
	});

	it("exposes every native DeepSeek V4.1 Flash effort on the DeepSeek provider", () => {
		const model = getModel("deepseek", "deepseek-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("keeps unclassified opencode-go DeepSeek controls fixed", () => {
		const model = getModel("opencode-go", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toEqual(["high"]);
	});

	it("preserves OpenRouter-published DeepSeek efforts", () => {
		const model = getModel("openrouter", "deepseek/deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high", "xhigh"]);
	});

	it("preserves OpenRouter-published DeepSeek V4.1 Flash efforts", () => {
		const model = getModel("openrouter", "deepseek/deepseek-v4.1-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
	});

	it("gives every generated reasoning model at least one selectable level", () => {
		for (const provider of getProviders()) {
			for (const model of getModels(provider)) {
				if (!model.reasoning) continue;
				expect(
					Object.values(model.thinkingLevelMap ?? {}).some((value) => typeof value === "number"),
					`${provider}/${model.id}`,
				).toBe(false);
				expect(getReasoningCapabilities(model), `${provider}/${model.id}`).toBeDefined();
				expect(getSupportedThinkingLevels(model).length, `${provider}/${model.id}`).toBeGreaterThan(0);
			}
		}
	});

	it("does not label multi-effort models as toggle controls", () => {
		for (const provider of getProviders()) {
			for (const model of getModels(provider)) {
				const capabilities = getReasoningCapabilities(model);
				if (capabilities?.control !== "toggle") continue;
				const activeLevels = getSupportedThinkingLevels(model).filter((level) => level !== "off");
				expect(activeLevels.length, `${provider}/${model.id}`).toBeLessThanOrEqual(1);
			}
		}
	});

	it("keeps every fixed contract to one selectable level", () => {
		for (const provider of getProviders()) {
			for (const model of getModels(provider)) {
				const capabilities = getReasoningCapabilities(model);
				if (capabilities?.control !== "fixed") continue;
				expect(getSupportedThinkingLevels(model), `${provider}/${model.id}`).toHaveLength(1);
			}
		}
	});

	it("uses exact provider/model capability matrices", () => {
		for (const provider of ["opencode", "github-copilot"] as const) {
			expect(getSupportedThinkingLevels(getModel(provider, "claude-fable-5"))).not.toContain("off");
			// Copilot dropped Opus 4.6; Sonnet 4.6 follows the same max-without-xhigh rule.
			const family46 = provider === "opencode" ? "claude-opus-4-6" : "claude-sonnet-4.6";
			const opus47 = provider === "opencode" ? "claude-opus-4-7" : "claude-opus-4.7";
			expect(getSupportedThinkingLevels(getModel(provider, family46 as never))).toContain("max");
			expect(getSupportedThinkingLevels(getModel(provider, opus47 as never))).toEqual(
				expect.arrayContaining(["xhigh", "max"]),
			);
		}
		const grok45 = getModel("xai", "grok-4.5");
		expect(grok45.compat?.supportsReasoningEffort).toBe(true);
		expect(getSupportedThinkingLevels(grok45)).toEqual(["low", "medium", "high"]);
		expect(getReasoningCapabilities(getModel("xai", "grok-4.3"))?.control).toBe("fixed");
		expect(getSupportedThinkingLevels(getModel("xai", "grok-4.3"))).toEqual(["high"]);
		expect(
			getReasoningCapabilities(getModel("cloudflare-workers-ai", "@cf/google/gemma-4-26b-a4b-it"))?.control,
		).toBe("fixed");
		expect(getReasoningCapabilities(getModel("cloudflare-ai-gateway", "claude-sonnet-4.5"))?.control).toBe("budget");
		expect(getSupportedThinkingLevels(getModel("zai", "glm-4.7"))).toEqual(["off", "high"]);
		expect(getSupportedThinkingLevels(getModel("zai", "glm-5.2"))).toEqual(["off", "high", "max"]);
		expect(getSupportedThinkingLevels(getModel("google", "gemini-2.5-pro"))).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
		]);
		expect(getSupportedThinkingLevels(getModel("google", "gemini-3.1-pro-preview"))).toEqual([
			"low",
			"medium",
			"high",
		]);
		expect(getSupportedThinkingLevels(getModel("openai", "gpt-5.4-pro"))).toEqual(["medium", "high", "xhigh"]);
		expect(getSupportedThinkingLevels(getModel("prime-inference", "openai/gpt-5.6"))).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(getReasoningCapabilities(getModel("github-copilot", "gpt-5-mini"))?.control).toBe("fixed");
		expect(getReasoningCapabilities(getModel("github-copilot", "gpt-5.4-mini"))?.control).toBe("fixed");
		expect(getReasoningCapabilities(getModel("github-copilot", "claude-haiku-4.5"))?.control).toBe("fixed");
		expect(getReasoningCapabilities(getModel("github-copilot", "kimi-k3"))?.control).toBe("fixed");
		expect(getReasoningCapabilities(getModel("github-copilot", "gpt-5.4"))?.control).toBe("effort");
		expect(getReasoningCapabilities(getModel("github-copilot", "claude-opus-4.7"))?.control).toBe("effort");
		expect(getSupportedThinkingLevels(getModel("github-copilot", "gpt-5.4"))).not.toContain("off");
		expect(getSupportedThinkingLevels(getModel("mistral", "mistral-small-2603"))).toEqual(["off", "high"]);
	});

	it("resolves legacy maps, generated overrides, and explicit capability contracts in precedence order", () => {
		const base = getModel("openai", "gpt-5.4");
		const overridden = {
			...base,
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
		};
		expect(getSupportedThinkingLevels(overridden)).toEqual(["high"]);

		const explicit = {
			...base,
			thinkingLevelMap: { high: "legacy-high" },
			reasoningCapabilities: { control: "effort" as const, levels: { off: "none", low: "exact-low" } },
		};
		expect(getSupportedThinkingLevels(explicit)).toEqual(["off", "low"]);
		expect(getReasoningCapabilities(explicit)).toBe(explicit.reasoningCapabilities);

		const legacy = { ...base, reasoningCapabilities: undefined, thinkingLevelMap: undefined };
		expect(getSupportedThinkingLevels(legacy)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});
});
