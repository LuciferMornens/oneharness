import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Model } from "../src/types.js";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);
	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		return headers.find(([key]) => key?.toLowerCase() === lowerName)?.[1] ?? null;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

const proxyModel = (compat?: Model<"openai-responses">["compat"]): Model<"openai-responses"> => ({
	...getModel("openai", "gpt-5.4"),
	provider: "opencode",
	baseUrl: "https://proxy.example.com/v1",
	...(compat ? { compat } : {}),
});

/** Drives one request against a stubbed SSE endpoint and returns the payload plus request headers. */
async function captureRequest(
	model: Model<"openai-responses">,
	options: Parameters<typeof streamOpenAIResponses>[2] = {},
): Promise<{ payload: unknown; sessionId: string | null; clientRequestId: string | null }> {
	const captured = {
		payload: undefined as unknown,
		sessionId: null as string | null,
		clientRequestId: null as string | null,
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
	});

	const stream = streamOpenAIResponses(
		model,
		{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{
			apiKey: "test-key",
			...options,
			onPayload: (payload) => {
				captured.payload = payload;
			},
		},
	);
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

// The provider never volunteers a reasoning field, so an unrequested effort always stays off the
// wire. On an explicit disable, "none" = the model exposes an off switch to serialize, "absent" =
// it has none (or a fixed control), so the field stays away.
const REASONING_DEFAULTS: Array<{
	provider: "openai" | "github-copilot";
	modelId: string;
	off: "none" | "absent";
	model: () => Model<"openai-responses">;
}> = [
	{
		provider: "github-copilot",
		modelId: "gpt-5-mini",
		off: "absent",
		model: () => getModel("github-copilot", "gpt-5-mini"),
	},
	...(["gpt-5.1", "gpt-5.2", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5"] as const).map(
		(modelId) => ({
			provider: "openai" as const,
			modelId,
			off: "none" as const,
			model: () => getModel("openai", modelId),
		}),
	),
	...(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const).map(
		(modelId) => ({
			provider: "openai" as const,
			modelId,
			off: "absent" as const,
			model: () => getModel("openai", modelId),
		}),
	),
];

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(REASONING_DEFAULTS)(
		"preserves the provider reasoning default for $provider $modelId when no reasoning is requested",
		async ({ model }) => {
			const { payload } = await captureRequest(model());

			expect(payload).not.toMatchObject({ reasoning: expect.anything() });
		},
	);

	it.each(REASONING_DEFAULTS)(
		"serializes $off reasoning effort for $provider $modelId when reasoning is explicitly disabled",
		async ({ off, model }) => {
			const { payload } = await captureRequest(model(), {
				reasoningEnabled: false,
				reasoningEffort: "high",
				reasoningSummary: "detailed",
			});

			const body = payload as { reasoning?: unknown; include?: unknown };
			if (off === "none") {
				expect(body.reasoning).toEqual({ effort: "none" });
			} else {
				expect(body.reasoning).toBeUndefined();
			}
			expect(body.include).toBeUndefined();
		},
	);

	it("keeps fixed reasoning controls off the wire", async () => {
		const fixedModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			reasoningCapabilities: { control: "fixed", levels: { high: "always" } },
			thinkingLevelMap: { high: "always" },
		};

		const { payload } = await captureRequest(fixedModel, { reasoningEffort: "high", reasoningEffortValue: "always" });

		expect(payload).not.toMatchObject({ reasoning: expect.anything() });
	});

	it("rejects numeric budget contracts before building a Responses request", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		let payloadBuilt = false;
		const model: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "custom-budget",
			reasoningCapabilities: { control: "budget", levels: { off: 0, high: 8192 } },
		};

		const result = await streamOpenAIResponses(
			model,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				reasoningEffort: "high",
				onPayload: () => {
					payloadBuilt = true;
				},
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(
			'API "openai-responses" accepts only string reasoning effort values and cannot serialize a numeric reasoning budget',
		);
		expect(payloadBuilt).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "official OpenAI Responses requests with a sessionId",
			model: () => getModel("openai", "gpt-5.4"),
			options: { sessionId: "session-123" },
			expected: { sessionId: "session-123", clientRequestId: "session-123" },
		},
		{
			name: "proxy Responses requests with a sessionId",
			model: () => proxyModel(),
			options: { sessionId: "session-123" },
			expected: { sessionId: "session-123", clientRequestId: "session-123" },
		},
		{
			name: "a model that opts out of the session_id header",
			model: () => proxyModel({ sendSessionIdHeader: false }),
			options: { sessionId: "session-123" },
			expected: { sessionId: null, clientRequestId: "session-123" },
		},
		{
			name: "explicit header overrides",
			model: () => getModel("openai", "gpt-5.4"),
			options: {
				sessionId: "session-123",
				headers: { session_id: "override-session", "x-client-request-id": "override-request" },
			},
			expected: { sessionId: "override-session", clientRequestId: "override-request" },
		},
		{
			name: "cacheRetention none",
			model: () => getModel("openai", "gpt-5.4"),
			options: { cacheRetention: "none" as const, sessionId: "session-123" },
			expected: { sessionId: null, clientRequestId: null },
		},
	])("sends cache-affinity headers for $name", async ({ model, options, expected }) => {
		const { sessionId, clientRequestId } = await captureRequest(model(), options);

		expect({ sessionId, clientRequestId }).toEqual(expected);
	});

	it.each([
		["github-copilot" as const, "auto" as const, false],
		["github-copilot" as const, "default" as const, false],
		["openai" as const, "default" as const, true],
	])("scopes service_tier serialization to the provider (%s, %s)", async (provider, serviceTier, expected) => {
		const model = { ...getModel("openai", "gpt-5.4"), provider };
		const sse = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		})}\n\n`;
		let wireBody: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const result = await streamOpenAIResponses(
			model,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key", serviceTier },
		).result();

		expect(result.stopReason).toBe("stop");
		// Copilot rejects the FIELD for every value; elsewhere absence means "auto"
		// (the project tier), so an explicit "default" must stay on the wire.
		expect(wireBody && "service_tier" in wireBody).toBe(expected);
		if (expected) {
			expect((wireBody as Record<string, unknown>).service_tier).toBe(serviceTier);
		}
	});
});
