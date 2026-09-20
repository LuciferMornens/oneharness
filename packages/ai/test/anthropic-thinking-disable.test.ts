import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { type AnthropicOptions, streamAnthropic } from "../src/providers/anthropic.js";
import { streamSimple } from "../src/stream.js";
import type { Context, Model, ModelReasoningCapabilities, SimpleStreamOptions, Tool } from "../src/types.js";

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

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

async function captureAnthropicRequest(
	model: Model<"anthropic-messages">,
	context: Context,
	options: AnthropicOptions,
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		capturedRequest = {
			headers: request.headers,
			body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
		};
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	try {
		const s = streamAnthropic({ ...model, baseUrl: `http://127.0.0.1:${port}` }, context, options);
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	if (!capturedRequest) throw new Error("Anthropic request was not captured");
	return capturedRequest;
}

function toolsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return (body.tools ?? []) as Array<Record<string, unknown>>;
}

function tool(name: string): Tool {
	return { name, description: `Tool ${name}`, parameters: Type.Object({ value: Type.String() }) };
}

const toolContext: Context = {
	messages: [{ role: "user", content: "Use the tool", timestamp: 1 }],
	tools: [tool("lookup")],
};

describe("Anthropic request wire contract", () => {
	const testModel: Model<"anthropic-messages"> = {
		...getModel("anthropic", "claude-opus-4-7"),
		provider: "test-anthropic",
	};

	it.each([
		{
			name: "sends per-tool eager_input_streaming by default",
			compat: undefined,
			context: toolContext,
			eager: true,
			beta: undefined,
		},
		{
			name: "uses the legacy fine-grained beta when eager tool input streaming is disabled",
			compat: { supportsEagerToolInputStreaming: false },
			context: toolContext,
			eager: undefined,
			beta: "fine-grained-tool-streaming-2025-05-14",
		},
		{
			name: "omits the legacy fine-grained beta when there are no tools",
			compat: { supportsEagerToolInputStreaming: false },
			context: { messages: toolContext.messages } as Context,
			eager: undefined,
			beta: undefined,
		},
	])("$name", async ({ compat, context, eager, beta }) => {
		const request = await captureAnthropicRequest({ ...testModel, compat }, context, {
			apiKey: "test-key",
			cacheRetention: "none",
		});

		expect(toolsOf(request.body)[0]?.eager_input_streaming).toBe(eager);
		expect(request.headers["anthropic-beta"]).toBe(beta);
	});

	it("renames user tools to their Claude Code casing only for OAuth tokens", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "Use the tools", timestamp: 1 }],
			tools: [tool("todowrite"), tool("find"), tool("my_custom_tool")],
		};

		const oauth = await captureAnthropicRequest(getModel("anthropic", "claude-sonnet-4-6"), context, {
			apiKey: "sk-ant-oat-fake-token",
			cacheRetention: "none",
		});
		expect(toolsOf(oauth.body).map((entry) => entry.name)).toEqual(["TodoWrite", "find", "my_custom_tool"]);

		const apiKey = await captureAnthropicRequest(getModel("anthropic", "claude-sonnet-4-6"), context, {
			apiKey: "sk-ant-api-fake-token",
			cacheRetention: "none",
		});
		expect(toolsOf(apiKey.body).map((entry) => entry.name)).toEqual(["todowrite", "find", "my_custom_tool"]);
	});

	it("sends Copilot bearer auth, Copilot headers, and a valid Anthropic Messages payload", async () => {
		const model = getModel("github-copilot", "claude-sonnet-4.6");
		expect(model.api).toBe("anthropic-messages");

		const request = await captureAnthropicRequest(
			model as Model<"anthropic-messages">,
			{ systemPrompt: "You are a helpful assistant.", messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ apiKey: "tid_copilot_session_test_token" },
		);

		expect(request.headers.authorization).toBe("Bearer tid_copilot_session_test_token");
		expect(request.headers["x-api-key"]).toBeUndefined();
		expect(request.headers["user-agent"]).toContain("GitHubCopilotChat");
		expect(request.headers["copilot-integration-id"]).toBe("vscode-chat");
		expect(request.headers["x-initiator"]).toBe("user");
		expect(request.headers["openai-intent"]).toBe("conversation-edits");
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("fine-grained-tool-streaming");

		expect(request.body.model).toBe("claude-sonnet-4.6");
		expect(request.body.stream).toBe(true);
		expect(request.body.max_tokens as number).toBeGreaterThan(0);
		expect(Array.isArray(request.body.messages)).toBe(true);
	});

	it("includes the interleaved-thinking beta for non-adaptive Copilot Claude models", async () => {
		const copilotHaiku = getModel("github-copilot", "claude-haiku-4.5") as Model<"anthropic-messages">;
		const helloContext: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };

		const request = await captureAnthropicRequest(copilotHaiku, helloContext, {
			apiKey: "tid_copilot_session_test_token",
			thinkingEnabled: true,
			interleavedThinking: true,
		});

		expect(request.headers["anthropic-beta"]).toContain("interleaved-thinking-2025-05-14");

		// The beta rides along with extended thinking only, matching the Bedrock provider:
		// asking for it while thinking is off leaves the header off the request.
		const thinkingOff = await captureAnthropicRequest(copilotHaiku, helloContext, {
			apiKey: "tid_copilot_session_test_token",
			interleavedThinking: true,
		});

		expect(thinkingOff.headers["anthropic-beta"]).toBeUndefined();
	});
});
