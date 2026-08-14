import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import {
	buildGrokProxyHeaders,
	GROK_CLI_BASE_URL,
	streamGrokResponses,
	streamSimpleGrokResponses,
} from "../src/providers/grok-responses.js";
import type { Context } from "../src/types.js";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

function buildContext(): Context {
	return {
		systemPrompt: "You are a test assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function sseResponse(): Response {
	const events = [
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		})}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}`,
		"data: [DONE]",
	];

	return new Response(`${events.join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("grok-responses provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("streams through the Grok CLI proxy with the proxy header contract", async () => {
		const model = getModel("grok", "grok-4.6");
		expect(model.api).toBe("grok-responses");
		expect(model.baseUrl).toBe(GROK_CLI_BASE_URL);

		let capturedUrl: string | undefined;
		let capturedHeaders: CapturedHeaders;
		let capturedBody: Record<string, unknown> | undefined;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedHeaders = init?.headers as CapturedHeaders;
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse();
		});

		const result = await streamGrokResponses(model, buildContext(), {
			apiKey: "grok-oauth-token",
			sessionId: "session-1234",
			reasoningEffort: "high",
		}).result();

		expect(capturedUrl).toBe(`${GROK_CLI_BASE_URL}/responses`);

		expect(getHeader(capturedHeaders, "authorization")).toBe("Bearer grok-oauth-token");
		expect(getHeader(capturedHeaders, "x-xai-token-auth")).toBe("xai-grok-cli");
		expect(getHeader(capturedHeaders, "x-authenticateresponse")).toBe("authenticate-response");
		expect(getHeader(capturedHeaders, "x-grok-client-identifier")).toBe("pi-ai");
		expect(getHeader(capturedHeaders, "x-grok-client-version")).toMatch(/^\d+\.\d+\.\d+$/);
		expect(["interactive", "headless"]).toContain(getHeader(capturedHeaders, "x-grok-client-mode"));
		expect(getHeader(capturedHeaders, "x-grok-conv-id")).toBe("session-1234");
		expect(getHeader(capturedHeaders, "x-grok-session-id")).toBe("session-1234");
		expect(getHeader(capturedHeaders, "x-grok-req-id")).toBeTruthy();
		expect(getHeader(capturedHeaders, "x-grok-model-override")).toBe("grok-4.6");

		expect(capturedBody).toMatchObject({
			model: "grok-4.6",
			stream: true,
			store: false,
			include: ["reasoning.encrypted_content"],
			reasoning: { effort: "high", summary: "auto" },
		});
		expect(Array.isArray(capturedBody?.input)).toBe(true);

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeFalsy();
		expect(result.content.map((block) => (block.type === "text" ? block.text : "")).join("")).toBe("Hello");
		expect(result.usage.input).toBe(5);
		expect(result.usage.output).toBe(3);
		expect(result.usage.totalTokens).toBe(8);
	});

	it("generates conversation affinity ids when no session id is provided", async () => {
		const model = getModel("grok", "grok-4.6");
		let capturedHeaders: CapturedHeaders;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedHeaders = init?.headers as CapturedHeaders;
			return sseResponse();
		});

		await streamGrokResponses(model, buildContext(), { apiKey: "grok-oauth-token" }).result();

		const convId = getHeader(capturedHeaders, "x-grok-conv-id");
		expect(convId).toBeTruthy();
		expect(getHeader(capturedHeaders, "x-grok-session-id")).toBe(convId);
		expect(getHeader(capturedHeaders, "x-grok-req-id")).toBeTruthy();
	});

	it("omits reasoning params for fixed-reasoning models", async () => {
		const model = getModel("grok", "grok-4.20-0309-reasoning");
		let capturedBody: Record<string, unknown> | undefined;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse();
		});

		await streamGrokResponses(model, buildContext(), {
			apiKey: "grok-oauth-token",
			reasoningEffort: "high",
			reasoningEffortValue: "always",
		}).result();

		expect(capturedBody?.reasoning).toBeUndefined();
		expect(capturedBody).toMatchObject({ store: false, include: ["reasoning.encrypted_content"] });
	});

	it("maps simple reasoning levels onto proxy reasoning efforts", async () => {
		const model = getModel("grok", "grok-4.6");
		let capturedBody: Record<string, unknown> | undefined;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse();
		});

		await streamSimpleGrokResponses(model, buildContext(), {
			apiKey: "grok-oauth-token",
			reasoning: "medium",
		}).result();

		expect(capturedBody?.reasoning).toMatchObject({ effort: "medium" });
	});

	it("fails without credentials instead of sending a request", async () => {
		const model = getModel("grok", "grok-4.6");
		const fetchMock = vi.spyOn(globalThis, "fetch");

		const result = await streamGrokResponses(model, buildContext(), {}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("No credentials for provider: grok");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("lets caller headers override the generated contract", async () => {
		const model = getModel("grok", "grok-4.6");
		let capturedHeaders: CapturedHeaders;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedHeaders = init?.headers as CapturedHeaders;
			return sseResponse();
		});

		await streamGrokResponses(model, buildContext(), {
			apiKey: "grok-oauth-token",
			headers: { "x-grok-client-mode": "headless" },
		}).result();

		expect(getHeader(capturedHeaders, "x-grok-client-mode")).toBe("headless");
	});

	it("surfaces proxy errors as stream failures", async () => {
		const model = getModel("grok", "grok-4.6");

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ error: { message: "Subscription required" } }), {
				status: 403,
				headers: { "content-type": "application/json" },
			}),
		);

		const result = await streamGrokResponses(model, buildContext(), {
			apiKey: "grok-oauth-token",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
	});
});

describe("buildGrokProxyHeaders", () => {
	it("normalizes model ids and reuses the session id for conversation affinity", () => {
		const headers = buildGrokProxyHeaders("Prefixed/Grok-4.6", "session-1");
		expect(headers["x-grok-model-override"]).toBe("grok-4.6");
		expect(headers["x-grok-conv-id"]).toBe("session-1");
		expect(headers["x-grok-session-id"]).toBe("session-1");
		expect(headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
	});

	it("issues a fresh request id per call", () => {
		const first = buildGrokProxyHeaders("grok-4.6", "session-1");
		const second = buildGrokProxyHeaders("grok-4.6", "session-1");
		expect(first["x-grok-req-id"]).not.toBe(second["x-grok-req-id"]);
	});
});
