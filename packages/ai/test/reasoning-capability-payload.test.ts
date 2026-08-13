import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

const mockState = vi.hoisted(() => ({ lastParams: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: {}, finish_reason: "stop" }] };
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const context = { messages: [{ role: "user" as const, content: "Hi", timestamp: 0 }] };

async function payload(
	provider: "deepseek" | "xai" | "zai",
	modelId: string,
	reasoning?: "off" | "low" | "medium" | "high" | "xhigh" | "max",
) {
	let captured: unknown;
	await streamSimple(getModel(provider, modelId as never), context, {
		apiKey: "test",
		...(reasoning !== undefined ? { reasoning } : {}),
		onPayload: (value) => {
			captured = value;
		},
	}).result();
	return (captured ?? mockState.lastParams) as Record<string, unknown>;
}

describe("reasoning capability payloads", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it.each(["low", "high", "max"] as const)("serializes DeepSeek V4 %s as an exact native effort", async (level) => {
		expect(await payload("deepseek", "deepseek-v4-flash", level)).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: level,
		});
	});

	it("disables DeepSeek thinking without sending an effort", async () => {
		const params = await payload("deepseek", "deepseek-v4-flash", "off");
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("disables DeepSeek thinking when reasoning is omitted", async () => {
		const params = await payload("deepseek", "deepseek-v4-flash");
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("serializes Z.AI GLM-5.2 high and max efforts", async () => {
		for (const level of ["high", "max"] as const) {
			expect(await payload("zai", "glm-5.2", level)).toMatchObject({
				thinking: { type: "enabled" },
				reasoning_effort: level,
			});
		}
	});

	it("uses a pure toggle for older Z.AI models", async () => {
		const enabled = await payload("zai", "glm-4.7", "high");
		expect(enabled.thinking).toEqual({ type: "enabled" });
		expect(enabled.reasoning_effort).toBeUndefined();

		const disabled = await payload("zai", "glm-4.7", "off");
		expect(disabled.thinking).toEqual({ type: "disabled" });
		expect(disabled.reasoning_effort).toBeUndefined();
	});

	it("serializes documented xAI Grok effort values", async () => {
		expect(await payload("xai", "grok-4.5", "medium")).toMatchObject({ reasoning_effort: "medium" });
		expect(await payload("xai", "grok-4.6", "xhigh")).toMatchObject({ reasoning_effort: "xhigh" });
	});

	it("omits reasoning controls for xAI routes without a documented control", async () => {
		const params = await payload("xai", "grok-4.3", "high");
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.thinking).toBeUndefined();
	});
});
