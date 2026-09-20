import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-4620 fast mode defaults", () => {
	let harness: Harness | undefined;
	const sessions: AgentSession[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) {
			session.dispose();
		}
		harness?.cleanup();
		harness = undefined;
	});

	it.each(["gpt-5.6-sol", "gpt-6-astra"])(
		"defaults ChatGPT-auth %s to fast when no preference is saved",
		async (id) => {
			harness = await createHarness({
				api: "openai-codex-responses",
				provider: "openai-codex",
				models: [{ id }],
			});

			expect(harness.settingsManager.getConfiguredDefaultServiceTier()).toBeUndefined();
			expect(harness.session.serviceTier).toBe("priority");
		},
	);

	it.each(["gpt-5.6-sol", "gpt-6-astra"])("keeps an explicit off preference over the %s fast default", async (id) => {
		harness = await createHarness({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [{ id }],
		});
		const currentHarness = harness;

		currentHarness.session.setServiceTier("default");
		expect(currentHarness.settingsManager.getDefaultServiceTier()).toBe("default");

		const { session } = await createAgentSession({
			cwd: currentHarness.tempDir,
			authStorage: currentHarness.authStorage,
			model: currentHarness.getModel(),
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.inMemory(currentHarness.tempDir),
			settingsManager: currentHarness.settingsManager,
		});
		sessions.push(session);
		expect(session.serviceTier).toBe("default");
	});

	it("defaults API Astra to fast and persists toggling it off and back on", async () => {
		harness = await createHarness({ api: "openai-responses", provider: "openai", models: [{ id: "gpt-6-astra" }] });
		expect(harness.session.serviceTier).toBe("priority");
		harness.session.setServiceTier("default");
		expect(harness.session.serviceTier).toBe("default");
		expect(harness.settingsManager.getConfiguredDefaultServiceTier()).toBe("default");
		harness.session.setServiceTier("priority");
		expect(harness.session.serviceTier).toBe("priority");
		expect(harness.settingsManager.getConfiguredDefaultServiceTier()).toBe("priority");
	});
});
