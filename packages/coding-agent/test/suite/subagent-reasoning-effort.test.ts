import { fauxAssistantMessage, getModel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { HostRequestHandlers } from "../../src/core/kernel/index.js";
import { findRlmModelMatches } from "../../src/core/rlm-runtime.js";
import { createHarness } from "./harness.js";

const provider = "faux-subagent-effort";

const opusLikeCapabilities = {
	control: "effort" as const,
	levels: {
		off: "off",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
};

const grok45LikeCapabilities = {
	control: "effort" as const,
	levels: {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	},
};

describe("subagent reasoning effort", () => {
	it("applies an explicit supported effort including xhigh instead of the parent level", async () => {
		const harness = await createHarness({
			provider,
			models: [
				{
					id: "parent-model",
					reasoning: true,
					reasoningCapabilities: grok45LikeCapabilities,
				},
				{
					id: "opus-like",
					name: "Opus Like",
					reasoning: true,
					reasoningCapabilities: opusLikeCapabilities,
				},
			],
		});
		try {
			harness.session.setThinkingLevel("medium");
			harness.setResponses([fauxAssistantMessage("child at xhigh")]);

			const result = await harness.session.runRlmChild("review at xhigh", {
				model: `${provider}/opus-like`,
				effort: "xhigh",
			});
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)).toBeDefined();
			});

			const child = harness.session.getRlmChildSession(result.rlm_child_id);
			expect(harness.session.thinkingLevel).toBe("medium");
			expect(child?.thinkingLevel).toBe("xhigh");
			expect(child?.model?.id).toBe("opus-like");
		} finally {
			harness.cleanup();
		}
	});

	it("inherits the parent effort clamped to the child model when effort is omitted", async () => {
		const harness = await createHarness({
			provider,
			models: [
				{
					id: "parent-model",
					reasoning: true,
					reasoningCapabilities: opusLikeCapabilities,
				},
				{
					id: "grok-45-like",
					name: "Grok 4.5 Like",
					reasoning: true,
					reasoningCapabilities: grok45LikeCapabilities,
				},
			],
		});
		try {
			harness.session.setThinkingLevel("xhigh");
			harness.setResponses([fauxAssistantMessage("inherited child")]);

			const result = await harness.session.runRlmChild("inherit effort", {
				model: `${provider}/grok-45-like`,
			});
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)).toBeDefined();
			});

			expect(harness.session.thinkingLevel).toBe("xhigh");
			expect(harness.session.getRlmChildSession(result.rlm_child_id)?.thinkingLevel).toBe("high");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects an unsupported requested effort at admission without starting a child", async () => {
		const harness = await createHarness({
			provider,
			models: [
				{
					id: "parent-model",
					reasoning: true,
					reasoningCapabilities: grok45LikeCapabilities,
				},
			],
		});
		try {
			harness.session.setThinkingLevel("medium");
			harness.setResponses([fauxAssistantMessage("should not run")]);

			await expect(
				harness.session.runRlmChild("unsupported xhigh", {
					model: `${provider}/parent-model`,
					effort: "xhigh",
				}),
			).rejects.toThrow(
				`Requested subagent effort "xhigh" is not supported by ${provider}/parent-model (supported: low, medium, high)`,
			);
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects an unknown effort string and a non-effort unknown kwarg without starting a child", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model", reasoning: true, reasoningCapabilities: opusLikeCapabilities }],
		});
		try {
			await expect(harness.session.runRlmChild("bad effort", { effort: "ultra" })).rejects.toThrow(
				"rlm.run effort must be one of off, minimal, low, medium, high, xhigh, max",
			);
			await expect(harness.session.runRlmChild("bad type", { effort: 3 })).rejects.toThrow(
				"rlm.run effort must be a string",
			);
			await expect(harness.session.runRlmChild("unknown option", { temperature: 0 })).rejects.toThrow(
				"Unsupported rlm.run kwargs: temperature",
			);
			await expect(harness.session.runRlmChild("wrong name", { thinking: "xhigh" })).rejects.toThrow(
				"Unsupported rlm.run kwargs: thinking",
			);
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("returns supported reasoning levels on the spawn-time find_models host path", async () => {
		const harness = await createHarness({
			provider,
			models: [
				{
					id: "parent-model",
					reasoning: true,
					reasoningCapabilities: grok45LikeCapabilities,
				},
				{
					id: "opus-like",
					name: "Opus Like",
					reasoning: true,
					reasoningCapabilities: opusLikeCapabilities,
				},
			],
		});
		try {
			const handlers = (
				harness.session as unknown as { _createKernelHostHandlers(): HostRequestHandlers }
			)._createKernelHostHandlers();
			const findModels = handlers["rlm.find_models"];
			if (!findModels) throw new Error("Missing rlm.find_models host handler");

			await expect(findModels({ query: "opus", limit: 5 })).resolves.toEqual({
				models: [
					{
						provider,
						id: "opus-like",
						name: "Opus Like",
						selector: `${provider}/opus-like`,
						reasoning_levels: ["off", "low", "medium", "high", "xhigh", "max"],
					},
				],
			});

			const grokMatches = await harness.session.findRlmModels("parent", 8);
			expect(grokMatches.models).toEqual([
				{
					provider,
					id: "parent-model",
					name: "parent-model",
					selector: `${provider}/parent-model`,
					reasoning_levels: ["low", "medium", "high"],
				},
			]);
			expect(grokMatches.models[0]?.reasoning_levels).not.toContain("xhigh");
		} finally {
			harness.cleanup();
		}
	});

	it("exposes catalog Opus 5 xhigh and xAI Grok 4.5's real supported levels", () => {
		const opus = getModel("anthropic", "claude-opus-5");
		const grok45 = getModel("xai", "grok-4.5");
		const opusMatches = findRlmModelMatches("opus 5", [opus], 8);
		const grokMatches = findRlmModelMatches("grok 4.5", [grok45], 8);

		expect(opusMatches[0]?.selector).toBe("anthropic/claude-opus-5");
		expect(opusMatches[0]?.reasoning_levels).toEqual(getSupportedThinkingLevels(opus));
		expect(opusMatches[0]?.reasoning_levels).toContain("xhigh");

		expect(grokMatches[0]?.selector).toBe("xai/grok-4.5");
		expect(grokMatches[0]?.reasoning_levels).toEqual(getSupportedThinkingLevels(grok45));
		expect(grokMatches[0]?.reasoning_levels).toEqual(["low", "medium", "high"]);
		expect(grokMatches[0]?.reasoning_levels).not.toContain("xhigh");
	});
});
