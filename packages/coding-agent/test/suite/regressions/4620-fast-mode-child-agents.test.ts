import { fauxAssistantMessage, getModel, supportsFastMode } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { resolveRlmSubagentServiceTier } from "../../../src/core/rlm-runtime.js";
import { createHarness } from "../harness.js";

const grok46Capabilities = {
	control: "effort" as const,
	levels: {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	},
};

const grok45Capabilities = {
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

const grokSubscriptionHarness = {
	api: "grok-responses",
	provider: "grok",
	models: [
		{
			id: "grok-4.6",
			reasoning: true,
			reasoningCapabilities: grok46Capabilities,
		},
		{
			id: "grok-4.5",
			reasoning: true,
			reasoningCapabilities: grok45Capabilities,
		},
		{ id: "grok-code-fast-1", reasoning: false },
	],
};

describe("ENG-4620 grok subscription fast mode child agents", () => {
	it("resolves grok-subscription fast models to priority from catalog entries", () => {
		expect(supportsFastMode(getModel("grok", "grok-4.6"))).toBe(true);
		expect(supportsFastMode(getModel("grok", "grok-4.5"))).toBe(true);
		expect(resolveRlmSubagentServiceTier(getModel("grok", "grok-4.6"), "default")).toBe("priority");
		expect(resolveRlmSubagentServiceTier(getModel("grok", "grok-4.5"), "default")).toBe("priority");
		expect(resolveRlmSubagentServiceTier(getModel("grok", "grok-4.6"), "priority")).toBe("priority");
		expect(resolveRlmSubagentServiceTier(getModel("xai", "grok-4.6"), "default")).toBe("default");
		expect(resolveRlmSubagentServiceTier(getModel("grok", "grok-4.3"), "default")).toBe("default");
		expect(resolveRlmSubagentServiceTier(getModel("grok", "grok-code-fast-1"), "default")).toBe("default");
		expect(resolveRlmSubagentServiceTier(getModel("openai-codex", "gpt-5.4"), "default")).toBe("default");
		expect(resolveRlmSubagentServiceTier(getModel("openai-codex", "gpt-5.4"), "priority")).toBe("priority");
	});

	it("defaults grok-4.6 grok-provider children to fast when the parent is not fast and effort is inherited high", async () => {
		const harness = await createHarness(grokSubscriptionHarness);
		try {
			expect(harness.session.serviceTier).toBe("default");
			expect(supportsFastMode(harness.session.model!)).toBe(true);
			harness.session.setThinkingLevel("high");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("priority");
					return fauxAssistantMessage("inherited high child");
				},
			]);

			const result = await harness.session.runRlmChild("review at inherited high");
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.getLastAssistantText()).toBe(
					"inherited high child",
				);
			});

			const child = harness.session.getRlmChildSession(result.rlm_child_id);
			expect(harness.session.serviceTier).toBe("default");
			expect(child?.serviceTier).toBe("priority");
			expect(child?.thinkingLevel).toBe("high");
			expect(child?.model?.provider).toBe("grok");
			expect(child?.model?.id).toBe("grok-4.6");
		} finally {
			harness.cleanup();
		}
	});

	it("defaults grok-4.6 grok-provider children to fast when rlm.run sets a non-low effort", async () => {
		const harness = await createHarness(grokSubscriptionHarness);
		try {
			expect(harness.session.serviceTier).toBe("default");
			harness.session.setThinkingLevel("medium");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("priority");
					return fauxAssistantMessage("explicit xhigh child");
				},
			]);

			const result = await harness.session.runRlmChild("review at xhigh", { effort: "xhigh" });
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.getLastAssistantText()).toBe(
					"explicit xhigh child",
				);
			});

			const child = harness.session.getRlmChildSession(result.rlm_child_id);
			expect(harness.session.serviceTier).toBe("default");
			expect(harness.session.thinkingLevel).toBe("medium");
			expect(child?.serviceTier).toBe("priority");
			expect(child?.thinkingLevel).toBe("xhigh");
		} finally {
			harness.cleanup();
		}
	});

	it("defaults grok-4.5 grok-provider children to fast at a non-low inherited effort", async () => {
		const harness = await createHarness(grokSubscriptionHarness);
		try {
			harness.session.setThinkingLevel("high");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("priority");
					return fauxAssistantMessage("grok-4.5 child");
				},
			]);

			const result = await harness.session.runRlmChild("review as grok-4.5", { model: "grok/grok-4.5" });
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.getLastAssistantText()).toBe(
					"grok-4.5 child",
				);
			});

			const child = harness.session.getRlmChildSession(result.rlm_child_id);
			expect(child?.serviceTier).toBe("priority");
			expect(child?.thinkingLevel).toBe("high");
			expect(child?.model?.id).toBe("grok-4.5");
		} finally {
			harness.cleanup();
		}
	});

	it("does not force fast on xai grok-4.6 children when the parent is default", async () => {
		const harness = await createHarness({
			api: "openai-completions",
			provider: "xai",
			models: [
				{
					id: "grok-4.6",
					reasoning: true,
					reasoningCapabilities: grok46Capabilities,
				},
			],
		});
		try {
			expect(supportsFastMode(harness.session.model!)).toBe(false);
			expect(harness.session.serviceTier).toBe("default");
			harness.session.setThinkingLevel("high");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("default");
					return fauxAssistantMessage("xai child");
				},
			]);

			const result = await harness.session.runRlmChild("review without grok subscription fast");
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.getLastAssistantText()).toBe("xai child");
			});

			const child = harness.session.getRlmChildSession(result.rlm_child_id);
			expect(child?.serviceTier).toBe("default");
			expect(child?.model?.provider).toBe("xai");
			expect(child?.model?.id).toBe("grok-4.6");
		} finally {
			harness.cleanup();
		}
	});

	it("does not force fast on grok children that do not support /fast", async () => {
		const harness = await createHarness(grokSubscriptionHarness);
		try {
			expect(harness.session.serviceTier).toBe("default");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("default");
					return fauxAssistantMessage("code-fast child");
				},
			]);

			const result = await harness.session.runRlmChild("use the non-fast grok model", {
				model: "grok/grok-code-fast-1",
			});
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.getLastAssistantText()).toBe(
					"code-fast child",
				);
			});

			const child = harness.session.getRlmChildSession(result.rlm_child_id);
			expect(child?.serviceTier).toBe("default");
			expect(child?.model?.id).toBe("grok-code-fast-1");
			expect(supportsFastMode(child!.model!)).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
