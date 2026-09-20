import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";

describe("Gateway catalog reasoning contracts", () => {
	it("exposes Gemini 3.8 Flash and Muse Spark 1.3 reasoning levels in catalog", () => {
		const gemini = getModel("openrouter", "google/gemini-3.8-flash");
		expect(gemini).toBeDefined();
		expect(getSupportedThinkingLevels(gemini)).toEqual(["low", "medium", "high"]);

		const museSpark = getModel("openrouter", "meta/muse-spark-1.3");
		expect(museSpark).toBeDefined();
		expect(getSupportedThinkingLevels(museSpark)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);

		const museContributor = getModel("openrouter", "meta/muse-spark-1.3-contributor");
		expect(museContributor).toBeDefined();
		expect(getSupportedThinkingLevels(museContributor)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
	});

	it("preserves DeepSeek reasoning replay metadata on OpenCode and OpenCode Go", () => {
		const opencodeFlash = getModel("opencode", "deepseek-v4-flash");
		expect(opencodeFlash.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect(opencodeFlash.compat?.thinkingFormat).toBe("deepseek");

		const opencodeGoFlash = getModel("opencode-go", "deepseek-v4-flash");
		expect(opencodeGoFlash.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect(opencodeGoFlash.compat?.thinkingFormat).toBe("deepseek");
	});

	it("exposes effort reasoning controls for Vercel AI Gateway Gemini 3.8 Flash", () => {
		const vercelGemini = getModel("vercel-ai-gateway", "google/gemini-3.8-flash");
		expect(vercelGemini).toBeDefined();
		expect(vercelGemini.reasoningCapabilities?.control).toBe("effort");
		expect(getSupportedThinkingLevels(vercelGemini)).toEqual(["low", "medium", "high"]);
	});

	it("does not include deprecated gemini-robotics-er-1.6-preview", () => {
		expect(getModel("google", "gemini-robotics-er-1.6-preview" as never)).toBeUndefined();
		expect(getModel("orcarouter", "google/gemini-robotics-er-1.6-preview" as never)).toBeUndefined();
	});

	it("restricts DeepSeek reasoning format to DeepSeek models on Cloudflare Workers AI", () => {
		const deepseekCf = getModel("cloudflare-workers-ai", "@cf/deepseek-ai/deepseek-v4-flash-0731");
		expect(deepseekCf.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect(deepseekCf.compat?.thinkingFormat).toBe("deepseek");

		const nonDeepseekCf = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");
		expect(nonDeepseekCf.compat?.thinkingFormat).toBeUndefined();
	});
});
