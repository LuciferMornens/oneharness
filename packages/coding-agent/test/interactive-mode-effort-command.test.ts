import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type EffortCommandContext = {
	connectionState?: {
		sessionId?: string;
		thinkingLevel: ThinkingLevel;
		availableThinkingLevels: ThinkingLevel[];
	};
	agentConnection: {
		setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
		getState: () => Promise<{
			sessionId: string;
			thinkingLevel: ThinkingLevel;
			availableThinkingLevels: ThinkingLevel[];
		}>;
	};
	footer: { invalidate: () => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	patchConnectionState: (patch: Record<string, unknown>) => void;
	updateEditorBorderColor: () => void;
};

type InteractiveModePrototype = {
	applyThinkingLevel(this: EffortCommandContext, level: ThinkingLevel, showConfirmation?: boolean): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type FastCommandContext = {
	connectionState?: { sessionId: string; serviceTier: ServiceTier; thinkingLevel: ThinkingLevel };
	fastModeToggleQueue: Promise<void>;
	agentConnection: {
		setServiceTier: (serviceTier: ServiceTier) => Promise<void>;
		getState: () => Promise<{ sessionId: string; serviceTier: ServiceTier }>;
	};
	footer: { invalidate: () => void };
	subagentSummaryLine: { invalidate: () => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	patchConnectionState: (patch: Record<string, unknown>) => void;
	getCurrentModel: () => Model<Api> | undefined;
	currentModelSupportsFastMode: () => boolean;
};

type FastInteractiveModePrototype = {
	currentModelSupportsFastMode(this: FastCommandContext): boolean;
	handleFastCommand(this: FastCommandContext): void;
};

const fastInteractiveModePrototype = InteractiveMode.prototype as unknown as FastInteractiveModePrototype;

function testModel(provider: string, id: string, api: Api): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function makeFastContext(model: Model<Api> = testModel("openai-codex", "gpt-5.5", "openai-codex-responses")) {
	const context: FastCommandContext = {
		connectionState: { sessionId: "session-1", serviceTier: "default", thinkingLevel: "high" },
		fastModeToggleQueue: Promise.resolve(),
		agentConnection: undefined as never,
		footer: { invalidate: vi.fn() },
		subagentSummaryLine: { invalidate: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		patchConnectionState: vi.fn((patch: Record<string, unknown>) => {
			context.connectionState = { ...context.connectionState, ...patch } as FastCommandContext["connectionState"];
		}),
		getCurrentModel: () => model,
		currentModelSupportsFastMode: () => fastInteractiveModePrototype.currentModelSupportsFastMode.call(context),
	};
	context.agentConnection = {
		setServiceTier: vi.fn(async (serviceTier) => {
			context.connectionState = { ...context.connectionState!, serviceTier };
		}),
		getState: vi.fn(async () => ({
			sessionId: context.connectionState!.sessionId,
			serviceTier: context.connectionState!.serviceTier,
		})),
	};
	return context;
}

function makeEffortContext(getState: EffortCommandContext["agentConnection"]["getState"]): EffortCommandContext {
	return {
		connectionState: {
			sessionId: "session-1",
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "low", "medium", "high"],
		},
		agentConnection: { setThinkingLevel: vi.fn(async () => {}), getState },
		footer: { invalidate: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		patchConnectionState: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	};
}

describe("InteractiveMode /effort", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	describe("command handling", () => {
		it("uses the effective level and dynamic list returned by the connection", async () => {
			const context = makeEffortContext(
				vi.fn(async () => ({
					sessionId: "session-1",
					thinkingLevel: "max" as ThinkingLevel,
					availableThinkingLevels: ["off", "low", "high", "max"] as ThinkingLevel[],
				})),
			);

			interactiveModePrototype.applyThinkingLevel.call(context, "xhigh");
			await vi.waitFor(() => expect(context.showStatus).toHaveBeenCalledWith("Thinking level: max"));

			expect(context.agentConnection.setThinkingLevel).toHaveBeenCalledWith("xhigh");
			expect(context.patchConnectionState).toHaveBeenCalledWith({
				thinkingLevel: "max",
				availableThinkingLevels: ["off", "low", "high", "max"],
			});
			expect(context.footer.invalidate).toHaveBeenCalledWith();
			expect(context.updateEditorBorderColor).toHaveBeenCalledWith();
			expect(context.showError).not.toHaveBeenCalled();
		});
	});

	describe("model switch refresh", () => {
		it("refreshes model-dependent state from the connection", async () => {
			type ModelState = {
				sessionId: string;
				model: unknown;
				thinkingLevel: ThinkingLevel;
				serviceTier: ServiceTier;
				availableThinkingLevels: ThinkingLevel[];
			};
			type ModelContext = {
				connectionState: { sessionId: string };
				agentConnection: {
					setModel: (provider: string, id: string) => Promise<void>;
					getState: () => Promise<ModelState>;
				};
				settingsManager: { setDefaultModelAndProvider: (provider: string, id: string) => void };
				patchConnectionState: (patch: Record<string, unknown>) => void;
				footer: { invalidate: () => void };
				subagentSummaryLine: { invalidate: () => void };
				updateEditorBorderColor: () => void;
				setupAutocompleteProvider: () => void;
				applyModelSwitchUiState: (state: ModelState, fallbackModel: unknown) => void;
			};
			const modelSwitchPrototype = InteractiveMode.prototype as unknown as {
				applySelectedModel(this: ModelContext, model: unknown): Promise<void>;
				applyModelSwitchUiState(this: ModelContext, state: ModelState, fallbackModel: unknown): void;
			};
			const patchConnectionState = vi.fn();
			const setupAutocompleteProvider = vi.fn();
			const model = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
			const context: ModelContext = {
				connectionState: { sessionId: "session-1" },
				agentConnection: {
					setModel: vi.fn(async () => {}),
					getState: vi.fn(
						async (): Promise<ModelState> => ({
							sessionId: "session-1",
							model,
							thinkingLevel: "max",
							serviceTier: "priority",
							availableThinkingLevels: ["off", "low", "high", "max"],
						}),
					),
				},
				settingsManager: { setDefaultModelAndProvider: vi.fn() },
				patchConnectionState,
				footer: { invalidate: vi.fn() },
				subagentSummaryLine: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				setupAutocompleteProvider,
				applyModelSwitchUiState: (state, fallbackModel) =>
					modelSwitchPrototype.applyModelSwitchUiState.call(context, state, fallbackModel),
			};

			await modelSwitchPrototype.applySelectedModel.call(context, model);

			const patch = patchConnectionState.mock.calls[0][0];
			expect(patch.model).toBe(model);
			expect(patch.thinkingLevel).toBe("max");
			expect(patch.serviceTier).toBe("priority");
			expect(patch.availableThinkingLevels).toEqual(["off", "low", "high", "max"]);
			expect(setupAutocompleteProvider).toHaveBeenCalledTimes(1);
		});
	});

	describe("Fast mode", () => {
		it.each(["low", "medium", "high", "xhigh", "max"] as const)(
			"toggles Astra fast off and on without changing %s reasoning",
			async (thinkingLevel) => {
				const context = makeFastContext(testModel("openai-codex", "gpt-6-astra", "openai-codex-responses"));
				context.connectionState = { sessionId: "session-1", serviceTier: "priority", thinkingLevel };
				fastInteractiveModePrototype.handleFastCommand.call(context);
				await context.fastModeToggleQueue;
				expect(context.showStatus).toHaveBeenLastCalledWith("Fast mode: off");
				expect(context.connectionState).toMatchObject({ serviceTier: "default", thinkingLevel });
				fastInteractiveModePrototype.handleFastCommand.call(context);
				await context.fastModeToggleQueue;
				expect(context.showStatus).toHaveBeenLastCalledWith("Fast mode: on");
				expect(context.connectionState).toMatchObject({ serviceTier: "priority", thinkingLevel });
			},
		);

		it("reports unsupported models without changing the service tier", () => {
			const context = makeFastContext(testModel("anthropic", "claude-opus", "anthropic-messages"));

			fastInteractiveModePrototype.handleFastCommand.call(context);

			expect(context.agentConnection.setServiceTier).not.toHaveBeenCalled();
			expect(context.showStatus).toHaveBeenCalledWith(
				"Fast mode requires GPT-5.4, GPT-5.5, or GPT-5.6 with ChatGPT or OpenAI API key authentication, or Grok 4.5/4.6 with an xAI Grok subscription",
			);
		});
	});
});
