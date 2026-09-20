import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import {
	streamAzureOpenAIResponses,
	streamSimpleAzureOpenAIResponses,
} from "../src/providers/azure-openai-responses.js";
import type { Context, Model } from "../src/types.js";

interface CapturedAzureClientOptions {
	apiKey: string;
	apiVersion: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string>;
	baseURL: string;
}

const azureMock = vi.hoisted(() => ({
	constructorCalls: [] as CapturedAzureClientOptions[],
}));

vi.mock("openai", () => {
	class AzureOpenAI {
		responses = {
			create: () => {
				throw new Error("mock create");
			},
		};

		constructor(config: CapturedAzureClientOptions) {
			azureMock.constructorCalls.push(config);
		}
	}

	return { AzureOpenAI };
});

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const azureEnvVars = [
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_API_KEY",
] as const;
const originalEnv = Object.fromEntries(azureEnvVars.map((name) => [name, process.env[name]]));

beforeEach(() => {
	azureMock.constructorCalls.length = 0;
	for (const name of azureEnvVars) delete process.env[name];
});

afterEach(() => {
	for (const name of azureEnvVars) {
		const value = originalEnv[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

async function streamOnce() {
	return streamAzureOpenAIResponses(getModel("azure-openai-responses", "gpt-4o-mini"), context, {
		apiKey: "test-api-key",
	}).result();
}

describe("azure-openai-responses base URL normalization", () => {
	it.each([
		[
			"cognitive services root",
			"https://res.cognitiveservices.azure.com",
			"https://res.cognitiveservices.azure.com/openai/v1",
		],
		["azure openai root", "https://res.openai.azure.com", "https://res.openai.azure.com/openai/v1"],
		[
			"/openai path",
			"https://res.cognitiveservices.azure.com/openai",
			"https://res.cognitiveservices.azure.com/openai/v1",
		],
		[
			"/openai/v1 path",
			"https://res.cognitiveservices.azure.com/openai/v1",
			"https://res.cognitiveservices.azure.com/openai/v1",
		],
		["non-azure proxy path", "https://my-proxy.example.com/v1", "https://my-proxy.example.com/v1"],
		[
			"azure query params",
			"https://res.openai.azure.com/openai?api-version=2024-12-01",
			"https://res.openai.azure.com/openai/v1",
		],
		[
			"non-azure query params",
			"https://my-proxy.example.com/v1?custom=true",
			"https://my-proxy.example.com/v1?custom=true",
		],
	])("normalizes %s", async (_name, baseUrl, expected) => {
		process.env.AZURE_OPENAI_BASE_URL = baseUrl;

		await streamOnce();

		expect(azureMock.constructorCalls).toHaveLength(1);
		expect(azureMock.constructorCalls[0].baseURL).toBe(expected);
	});

	it("builds the default URL from AZURE_OPENAI_RESOURCE_NAME", async () => {
		process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";

		await streamOnce();

		expect(azureMock.constructorCalls[0].baseURL).toBe("https://my-resource.openai.azure.com/openai/v1");
	});

	it("fails the stream on an invalid base URL", async () => {
		process.env.AZURE_OPENAI_BASE_URL = "not-a-url";

		const result = await streamOnce();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid Azure OpenAI base URL");
	});
});

describe("azure-openai-responses reasoning controls", () => {
	it("uses authoritative capability values, preserves defaults, and keeps fixed controls wire-silent", async () => {
		process.env.AZURE_OPENAI_BASE_URL = "https://my-resource.openai.azure.com";
		let payload: unknown;
		await streamSimpleAzureOpenAIResponses(getModel("azure-openai-responses", "gpt-5.6"), context, {
			apiKey: "test-api-key",
			reasoning: "max",
			onPayload: (value) => {
				payload = value;
			},
		}).result();
		expect(payload).toMatchObject({ reasoning: { effort: "max" } });

		await streamSimpleAzureOpenAIResponses(getModel("azure-openai-responses", "gpt-5.1"), context, {
			apiKey: "test-api-key",
			onPayload: (value) => {
				payload = value;
			},
		}).result();
		expect(payload).not.toMatchObject({ reasoning: expect.anything() });

		const fixedModel = {
			...getModel("azure-openai-responses", "gpt-5.6"),
			reasoningCapabilities: { control: "fixed" as const, levels: { high: "always" } },
			thinkingLevelMap: { high: "always" },
		};
		await streamSimpleAzureOpenAIResponses(fixedModel, context, {
			apiKey: "test-api-key",
			reasoning: "high",
			onPayload: (value) => {
				payload = value;
			},
		}).result();
		expect(payload).not.toMatchObject({ reasoning: expect.anything() });

		await streamAzureOpenAIResponses(getModel("azure-openai-responses", "gpt-5.6"), context, {
			apiKey: "test-api-key",
			reasoningEnabled: false,
			reasoningEffort: "max",
			reasoningSummary: "detailed",
			onPayload: (value) => {
				payload = value;
			},
		}).result();
		expect(payload).toMatchObject({ reasoning: { effort: "none" } });
		expect(payload).not.toMatchObject({ reasoning: { summary: expect.anything() } });

		await streamAzureOpenAIResponses(getModel("azure-openai-responses", "gpt-5-pro"), context, {
			apiKey: "test-api-key",
			reasoningEnabled: false,
			reasoningEffort: "high",
			reasoningSummary: "detailed",
			onPayload: (value) => {
				payload = value;
			},
		}).result();
		expect(payload).not.toMatchObject({ reasoning: expect.anything() });
	});

	it("rejects numeric budget contracts before building an Azure Responses request", async () => {
		process.env.AZURE_OPENAI_BASE_URL = "https://my-resource.openai.azure.com";
		let payloadBuilt = false;
		const model: Model<"azure-openai-responses"> = {
			...getModel("azure-openai-responses", "gpt-5.6"),
			provider: "custom-budget",
			reasoningCapabilities: { control: "budget", levels: { off: 0, high: 8192 } },
		};

		const result = await streamAzureOpenAIResponses(model, context, {
			apiKey: "test-api-key",
			reasoningEffort: "high",
			onPayload: () => {
				payloadBuilt = true;
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(
			'API "azure-openai-responses" accepts only string reasoning effort values and cannot serialize a numeric reasoning budget',
		);
		expect(payloadBuilt).toBe(false);
	});
});
