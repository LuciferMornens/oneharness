import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.js";
import { defaultModelPerProvider } from "../src/core/model-resolver.js";

describe("xAI Grok subscription provider wiring", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-grok-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearApiKeyCache();
	});

	test("lists the grok OAuth provider for /login", () => {
		const providers = authStorage.getOAuthProviders();
		const grok = providers.find((provider) => provider.id === "grok");
		expect(grok).toBeDefined();
		expect(grok?.name).toContain("xAI Grok");
	});

	test("grok models stay hidden until OAuth credentials are stored", () => {
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		const before = registry.getAvailable().filter((model) => model.provider === "grok");
		expect(before).toHaveLength(0);
	});

	test("stored grok OAuth credentials surface the subscription models and bearer", async () => {
		authStorage.set("grok", {
			type: "oauth",
			access: "grok-access-token",
			refresh: "grok-refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
		});

		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		const grokModels = registry.getAvailable().filter((model) => model.provider === "grok");

		expect(grokModels.length).toBeGreaterThan(0);
		const defaultModel = grokModels.find((model) => model.id === defaultModelPerProvider.grok);
		expect(defaultModel).toBeDefined();
		expect(defaultModel?.api).toBe("grok-responses");
		expect(defaultModel?.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");

		await expect(authStorage.getApiKey("grok")).resolves.toBe("grok-access-token");
	});

	test("keeps the pay-per-token xai provider separate from the grok subscription provider", () => {
		authStorage.set("grok", {
			type: "oauth",
			access: "grok-access-token",
			refresh: "grok-refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
		});

		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		const xaiModels = registry.getAll().filter((model) => model.provider === "xai");

		expect(xaiModels.length).toBeGreaterThan(0);
		for (const model of xaiModels) {
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.x.ai/v1");
		}

		// xai stays unavailable without an API key even when grok OAuth is configured
		const availableXai = registry.getAvailable().filter((model) => model.provider === "xai");
		expect(availableXai).toHaveLength(0);
	});
});
