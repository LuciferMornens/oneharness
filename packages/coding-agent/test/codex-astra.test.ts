import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { resolveCliModel } from "../src/core/model-resolver.js";

const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const token = `test.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "astra-test-account" } }),
).toString("base64url")}.test`;

function subscriptionRegistry(): ModelRegistry {
	return ModelRegistry.inMemory(
		AuthStorage.inMemory(
			{
				"openai-codex": {
					type: "oauth",
					access: token,
					refresh: "unused-test-refresh",
					expires: Date.now() + 3_600_000,
				},
			},
			{ usePrimeCliConfig: false },
		),
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("GPT-6 Astra subscription selection", () => {
	it("is available with existing Codex OAuth credentials", async () => {
		const registry = subscriptionRegistry();
		const model = registry.find("openai-codex", "gpt-6-astra");
		expect(model).toBeDefined();
		expect(registry.getAvailable()).toContain(model);
		expect(registry.isUsingOAuth(model!)).toBe(true);
		expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({ ok: true, apiKey: token });
		expect(getSupportedThinkingLevels(model!)).toEqual(efforts);
	});

	it.each(efforts)("resolves the subscription model with the %s effort suffix", (effort) => {
		const result = resolveCliModel({
			modelRegistry: subscriptionRegistry(),
			cliModel: `openai-codex/gpt-6-astra:${effort}`,
		});
		expect(result.error).toBeUndefined();
		expect(result.model).toMatchObject({ provider: "openai-codex", id: "gpt-6-astra" });
		expect(result.thinkingLevel).toBe(effort);
	});

	it("discovers Astra for subagents using an Astra-capable Codex client version", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
			const url = new URL(String(input));
			const version = url.searchParams.get("client_version")?.split(".").map(Number) ?? [];
			const supportsAstra = (version[0] ?? 0) > 0 || (version[1] ?? 0) >= 153;
			return Response.json({ models: supportsAstra ? [{ slug: "gpt-6-astra" }] : [] });
		});
		vi.stubGlobal("fetch", fetchMock);
		const registry = subscriptionRegistry();
		const executable = await registry.getExecutableModels();

		expect(executable.filter((model) => model.provider === "openai-codex")).toEqual([
			expect.objectContaining({ id: "gpt-6-astra", api: "openai-codex-responses" }),
		]);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(new URL(String(url)).pathname).toBe("/backend-api/codex/models");
		expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
		expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("astra-test-account");
	});

	it("keeps Astra unavailable to subagents when the account catalog does not include it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [{ slug: "gpt-5.6-sol" }] })),
		);
		const executable = await subscriptionRegistry().getExecutableModels();
		expect(executable.some((model) => model.provider === "openai-codex" && model.id === "gpt-6-astra")).toBe(false);
		expect(executable.some((model) => model.provider === "openai-codex" && model.id === "gpt-5.6-sol")).toBe(true);
	});
});
