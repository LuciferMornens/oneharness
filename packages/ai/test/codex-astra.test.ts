import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";
import { streamSimpleOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { Context } from "../src/types.js";

const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const token = `test.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "astra-test-account" } }),
).toString("base64url")}.test`;
const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

function mockResponses() {
	const events = [
		{ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				content: [{ type: "output_text", text: "Hello" }],
			},
		},
		{ type: "response.completed", response: { status: "completed" } },
	];
	const fetchMock = vi.fn<typeof fetch>().mockImplementation(
		async () =>
			new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("GPT-6 Astra Codex subscription", () => {
	it("registers the subscription endpoint, limits, and exact reasoning choices", () => {
		const model = getModel("openai-codex", "gpt-6-astra");
		expect(model).toMatchObject({
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			contextWindow: 272000,
			maxTokens: 128000,
			input: ["text", "image"],
		});
		expect(getSupportedThinkingLevels(model)).toEqual(efforts);
	});

	it.each(efforts)("sends %s reasoning unchanged with ChatGPT OAuth", async (reasoning) => {
		const fetchMock = mockResponses();
		const result = await streamSimpleOpenAICodexResponses(getModel("openai-codex", "gpt-6-astra"), context, {
			apiKey: token,
			transport: "sse",
			reasoning,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Hello" })]);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
		expect(headers.get("chatgpt-account-id")).toBe("astra-test-account");
		expect(headers.has("x-api-key")).toBe(false);
		expect(JSON.parse(String(init?.body))).toMatchObject({
			model: "gpt-6-astra",
			store: false,
			stream: true,
			reasoning: { effort: reasoning, summary: "auto" },
		});
	});

	it.each(["off", "minimal"] as const)("clamps unsupported %s reasoning to low", async (reasoning) => {
		const fetchMock = mockResponses();
		const result = await streamSimpleOpenAICodexResponses(getModel("openai-codex", "gpt-6-astra"), context, {
			apiKey: token,
			transport: "sse",
			reasoning,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			reasoning: { effort: "low" },
		});
	});

	it("preserves the server reasoning default when no effort is selected", async () => {
		const fetchMock = mockResponses();
		const result = await streamSimpleOpenAICodexResponses(getModel("openai-codex", "gpt-6-astra"), context, {
			apiKey: token,
			transport: "sse",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("reasoning");
	});
});
