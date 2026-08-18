import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import { streamSimple } from "../src/stream.js";
import type { Context, Model, ModelReasoningCapabilities, SimpleStreamOptions } from "../src/types.js";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	temperature?: number;
	max_tokens?: number;
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			return payload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

interface RunResult {
	thinkingEventCount: number;
	thinkingCharCount: number;
	text: string;
	contentTypes: string[];
}

function makeE2EContext(): Context {
	return {
		systemPrompt: "You are a precise assistant. Follow the requested output format exactly.",
		messages: [
			{
				role: "user",
				content:
					"Before replying, carefully solve 36863 * 5279 internally. Then reply with the word pong repeated exactly 40 times, separated by single spaces. Do not add any other text.",
				timestamp: Date.now(),
			},
		],
	};
}

function countPongs(text: string): number {
	return text.match(/\bpong\b/gi)?.length ?? 0;
}

async function runWithoutReasoning(model: Model<"anthropic-messages">): Promise<RunResult> {
	const s = streamSimple(model, makeE2EContext(), {
		reasoning: "off",
		temperature: 0,
		maxTokens: 160,
	});

	let thinkingEventCount = 0;
	let thinkingCharCount = 0;

	for await (const event of s) {
		if (event.type === "thinking_start" || event.type === "thinking_end") {
			thinkingEventCount += 1;
		}
		if (event.type === "thinking_delta") {
			thinkingEventCount += 1;
			thinkingCharCount += event.delta.length;
		}
	}

	const response = await s.result();
	expect(response.stopReason, response.errorMessage).toBe("stop");

	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();

	return {
		thinkingEventCount,
		thinkingCharCount,
		text,
		contentTypes: response.content.map((block) => block.type),
	};
}

describe("Anthropic thinking disable payload", () => {
	it("preserves temperature and provider thinking defaults when reasoning is omitted", async () => {
		for (const model of [
			getModel("anthropic", "claude-sonnet-4-5"),
			getModel("cloudflare-ai-gateway", "claude-sonnet-4.5"),
			getModel("vercel-ai-gateway", "anthropic/claude-sonnet-4.5"),
		]) {
			const payload = await capturePayload(model, { temperature: 0.4 });
			expect(payload.temperature).toBe(0.4);
			expect(payload.thinking).toBeUndefined();
		}
	});

	it("sends thinking.type=disabled for budget-based reasoning models when thinking is off", async () => {
		for (const model of [
			getModel("anthropic", "claude-sonnet-4-5"),
			getModel("cloudflare-ai-gateway", "claude-sonnet-4.5"),
			getModel("vercel-ai-gateway", "anthropic/claude-sonnet-4.5"),
		]) {
			const payload = await capturePayload(model, { reasoning: "off" });
			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.output_config).toBeUndefined();
		}
	});

	it("uses numeric capability budgets in max-token adjustment and clamps the budget below max tokens", async () => {
		const baseModel = getModel("anthropic", "claude-sonnet-4-5");
		const model: Model<"anthropic-messages"> = {
			...baseModel,
			maxTokens: 4096,
			reasoningCapabilities: { control: "budget", supportsOff: true, levels: { high: 10000 } },
		};
		const payload = await capturePayload(model, { reasoning: "high", maxTokens: 1000 });

		expect(payload.max_tokens).toBe(4096);
		expect(payload.thinking).toMatchObject({ type: "enabled", budget_tokens: 3072 });
		expect(payload.thinking?.budget_tokens).toBeLessThan(payload.max_tokens!);
	});

	it.each([
		["budget below the provider minimum", { control: "budget", levels: { high: 1023 } }, "at least 1024"],
		[
			"synthetic numeric off budget",
			{ control: "budget", levels: { off: 0, high: 1024 } },
			'budget level "off" is structural',
		],
		["fractional budget", { control: "budget", levels: { high: 1024.5 } }, "finite integer token value"],
		["numeric effort", { control: "effort", levels: { high: 8192 } }, "must use a non-empty string"],
	] as const)("rejects an invalid Anthropic %s before payload construction", async (_name, contract, message) => {
		let payloadBuilt = false;
		const model: Model<"anthropic-messages"> = {
			...getModel("anthropic", "claude-sonnet-4-5"),
			reasoningCapabilities: contract as unknown as ModelReasoningCapabilities,
		};
		const result = await streamAnthropic(model, makePayloadCaptureContext(), {
			apiKey: "fake-key",
			thinkingEnabled: true,
			onPayload: () => {
				payloadBuilt = true;
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(message);
		expect(payloadBuilt).toBe(false);
	});

	it("serializes an exact custom effort contract without model-name inference", async () => {
		const model: Model<"anthropic-messages"> = {
			...getModel("anthropic", "claude-sonnet-4-5"),
			id: "opaque-effort-route",
			name: "Opaque Effort Route",
			provider: "custom-anthropic",
			reasoningCapabilities: {
				control: "effort",
				levels: { off: null, high: "turbo" },
			},
		};

		const payload = await capturePayload(model, { reasoning: "high" });
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "turbo" });
	});

	it("serializes Fireworks Anthropic-compatible budget controls and preserves temperature", async () => {
		const model = getModel("fireworks", "accounts/fireworks/models/deepseek-v4-flash");
		expect(model.reasoningCapabilities).toMatchObject({
			control: "budget",
			supportsOff: true,
			levels: { minimal: 1024, low: 2048, medium: 8192, high: 16384 },
		});

		const enabled = await capturePayload(model, { reasoning: "low", temperature: 0.4 });
		expect(enabled.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
		expect(enabled.output_config).toBeUndefined();
		expect(enabled.temperature).toBe(0.4);

		const disabled = await capturePayload(model, { reasoning: "off", temperature: 0.4 });
		expect(disabled.thinking).toEqual({ type: "disabled" });
		expect(disabled.temperature).toBe(0.4);
	});

	it("serializes Kimi Coding native effort and budget controls", async () => {
		const k3 = getModel("kimi-coding", "k3");
		expect(k3.reasoningCapabilities).toMatchObject({
			control: "effort",
			levels: { off: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
		});

		const medium = await capturePayload(k3, { reasoning: "medium", temperature: 0.3 });
		expect(medium.thinking).toBeUndefined();
		expect(medium.output_config).toEqual({ effort: "high" });
		expect(medium.temperature).toBe(0.3);

		const maximum = await capturePayload(k3, { reasoning: "xhigh" });
		expect(maximum.output_config).toEqual({ effort: "max" });

		const disabled = await capturePayload(k3, { reasoning: "off", temperature: 0.3 });
		expect(disabled.thinking).toBeUndefined();
		expect(disabled.output_config).toEqual({ effort: "none" });
		expect(disabled.temperature).toBe(0.3);

		let directPayload: AnthropicThinkingPayload | undefined;
		await streamAnthropic({ ...k3, baseUrl: "http://127.0.0.1:9" }, makePayloadCaptureContext(), {
			apiKey: "fake-key",
			thinkingEnabled: false,
			effort: "high",
			onPayload: (payload) => {
				directPayload = payload as AnthropicThinkingPayload;
				return payload;
			},
		}).result();
		expect(directPayload?.thinking).toBeUndefined();
		expect(directPayload?.output_config).toEqual({ effort: "none" });

		const k27 = getModel("kimi-coding", "kimi-for-coding");
		expect(k27.reasoningCapabilities).toMatchObject({
			control: "budget",
			supportsOff: true,
			levels: { minimal: 1024, low: 2048, medium: 8192, high: 16384 },
		});
		const enabled = await capturePayload(k27, { reasoning: "high", temperature: 0.3 });
		expect(enabled.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
		expect(enabled.output_config).toBeUndefined();
		expect(enabled.temperature).toBe(0.3);
	});

	it("sends thinking.type=disabled for adaptive reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6"), { reasoning: "off" });

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for Claude Opus 4.7 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { reasoning: "off" });

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("uses adaptive thinking for Claude Opus 4.7 when reasoning is enabled", async () => {
		for (const model of [
			getModel("anthropic", "claude-opus-4-7"),
			getModel("cloudflare-ai-gateway", "claude-opus-4.7"),
			getModel("vercel-ai-gateway", "anthropic/claude-opus-4.7"),
		]) {
			const payload = await capturePayload(model, { reasoning: "high" });
			expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(payload.output_config).toEqual({ effort: "high" });
		}
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.7", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("maps max reasoning to effort=max for Claude Opus 4.7", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { reasoning: "max" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("maps max reasoning to effort=max for Claude Opus 4.6 (no native xhigh)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6"), { reasoning: "max" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("clamps xhigh reasoning to effort=max for Claude Opus 4.6 (no native xhigh)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6"), { reasoning: "xhigh" });

		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("maps max reasoning to effort=max for Claude Sonnet 4.6 (no native xhigh)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-6"), { reasoning: "max" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("preserves the always-on Claude Fable 5 default when reasoning is omitted", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"));

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
	});

	it("omits disabled thinking for always-on models even in direct provider options", async () => {
		const model: Model<"anthropic-messages"> = {
			...getModel("anthropic", "claude-fable-5"),
			baseUrl: "http://127.0.0.1:9",
		};
		let payload: AnthropicThinkingPayload | undefined;
		await streamAnthropic(model, makePayloadCaptureContext(), {
			apiKey: "fake-key",
			thinkingEnabled: false,
			onPayload: (value) => {
				payload = value as AnthropicThinkingPayload;
				return value;
			},
		}).result();

		expect(payload?.thinking).toBeUndefined();
	});

	it("drops temperature for Claude Fable 5 (sampling params are rejected)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), { temperature: 0.5 });

		expect(payload.temperature).toBeUndefined();
		expect(payload.thinking).toBeUndefined();
	});

	it("uses adaptive thinking with effort=xhigh for Claude Fable 5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("maps max reasoning to effort=max for Claude Fable 5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), { reasoning: "max" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic thinking disable E2E", () => {
	it("disables thinking for Claude reasoning models", { retry: 2, timeout: 30000 }, async () => {
		const result = await runWithoutReasoning(getModel("anthropic", "claude-sonnet-4-5"));

		expect(result.thinkingEventCount).toBe(0);
		expect(result.thinkingCharCount).toBe(0);
		expect(result.contentTypes).not.toContain("thinking");
		expect(countPongs(result.text)).toBeGreaterThanOrEqual(35);
	});
});
