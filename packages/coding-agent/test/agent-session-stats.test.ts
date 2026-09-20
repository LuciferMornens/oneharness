import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createSession(): AgentSession {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("AgentSession.cycleThinkingLevel", () => {
	it("leaves thinking state unchanged when no reasoning level is selectable", () => {
		const session = createSession();

		try {
			session.agent.state.model = {
				...model,
				reasoningCapabilities: { control: "effort", levels: {} },
				thinkingLevelMap: {},
			};
			const previousLevel = session.thinkingLevel;

			expect(session.getAvailableThinkingLevels()).toEqual([]);
			expect(session.cycleThinkingLevel()).toBeUndefined();
			expect(session.thinkingLevel).toBe(previousLevel);
		} finally {
			session.dispose();
		}
	});
});
