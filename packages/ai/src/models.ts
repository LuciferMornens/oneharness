import { MODELS } from "./models.generated.js";
import { getLegacyGoogleReasoningLevels, overlayLegacyGoogleLevels } from "./providers/google-thinking.js";
import type {
	Api,
	KnownProvider,
	Model,
	ModelReasoningCapabilities,
	ModelThinkingLevel,
	OpenAICompletionsCompat,
	ReasoningEffortLevelMap,
	ServiceTier,
	ThinkingLevelMap,
	ThinkingLevelValue,
	Usage,
} from "./types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();
const generatedReasoningContracts = new WeakMap<ModelReasoningCapabilities, ThinkingLevelMap | undefined>();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		const registeredModel = model as Model<Api>;
		providerModels.set(id, registeredModel);
		if (registeredModel.reasoningCapabilities) {
			generatedReasoningContracts.set(registeredModel.reasoningCapabilities, registeredModel.thinkingLevelMap);
		}
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

export function supportsFastMode<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.provider === "grok" && model.api === "grok-responses") {
		// Grok fast mode is low reasoning effort on the same model id, not a separate model.
		const capabilities = getReasoningCapabilities(model);
		return capabilities?.control === "effort" && capabilities.levels.low != null;
	}
	return (
		model.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		(model.id === "gpt-5.4" || model.id === "gpt-5.5" || model.id === "gpt-5.6" || model.id.startsWith("gpt-5.6-"))
	);
}

/** Default service tier when the user has not saved a preference. */
export function defaultServiceTierForModel<TApi extends Api>(model: Model<TApi> | undefined | null): ServiceTier {
	if (model && model.provider === "openai-codex" && supportsFastMode(model)) {
		return "priority";
	}
	return "default";
}

export interface CostOverrides {
	cacheWrite?: number;
}

export function calculateCost<TApi extends Api>(
	model: Model<TApi>,
	usage: Usage,
	overrides?: CostOverrides,
): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = ((overrides?.cacheWrite ?? model.cost.cacheWrite) / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const LEGACY_EFFORT_LEVELS: ReasoningEffortLevelMap = {
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
};

const LEGACY_MISTRAL_TOGGLE_LEVELS: ThinkingLevelMap = { off: "off", high: "high" };
const LEGACY_MISTRAL_EFFORT_LEVELS: ReasoningEffortLevelMap = { off: "none", high: "high" };

function usesLegacyMistralReasoningEffort<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.api !== "mistral-conversations") return false;
	const id = model.id.toLowerCase();
	return (
		model.thinkingLevelMap?.off === "none" ||
		id === "mistral-small-2603" ||
		id === "mistral-small-latest" ||
		id === "mistral-medium-3.5" ||
		id === "mistral-medium-3-5" ||
		id === "mistral-medium-2604" ||
		id === "mistral-medium-latest"
	);
}

export interface ResolvedThinkingLevel {
	level: ModelThinkingLevel;
	enabled: boolean;
	providerValue?: ThinkingLevelValue;
}

function assertFixedReasoningContract<TApi extends Api>(
	model: Model<TApi>,
	capabilities: Extract<ModelReasoningCapabilities, { control: "fixed" }>,
	legacyOverlay = false,
): void {
	const selectableLevels = Object.entries(capabilities.levels).filter(
		([, value]) => typeof value === "string" || typeof value === "number",
	);
	if (selectableLevels.length === 1) return;

	const guidance = legacyOverlay
		? " A legacy thinkingLevelMap overlay cannot add choices to an intrinsically fixed route; replace reasoningCapabilities with an explicit non-fixed contract."
		: " Fixed reasoning must expose exactly one selectable level.";
	throw new Error(
		`Model ${model.provider}/${model.id}: fixed reasoning contract exposes ${selectableLevels.length} selectable levels.${guidance}`,
	);
}

/** Return the route's single authoritative reasoning capability contract. */
export function getReasoningCapabilities<TApi extends Api>(model: Model<TApi>): ModelReasoningCapabilities | undefined {
	const configuredCapabilities = model.reasoningCapabilities as { control?: unknown } | undefined;
	if (
		configuredCapabilities &&
		configuredCapabilities.control !== "fixed" &&
		configuredCapabilities.control !== "toggle" &&
		configuredCapabilities.control !== "effort" &&
		configuredCapabilities.control !== "budget"
	) {
		throw new Error(
			`Model ${model.provider}/${model.id}: unknown reasoningCapabilities.control ${JSON.stringify(configuredCapabilities.control)}.`,
		);
	}
	if (!model.reasoning) return undefined;
	if (model.reasoningCapabilities) {
		const generatedMap = generatedReasoningContracts.get(model.reasoningCapabilities);
		if (
			generatedReasoningContracts.has(model.reasoningCapabilities) &&
			model.thinkingLevelMap &&
			model.thinkingLevelMap !== generatedMap
		) {
			const capabilities = {
				...model.reasoningCapabilities,
				levels: { ...model.reasoningCapabilities.levels, ...model.thinkingLevelMap },
			} as ModelReasoningCapabilities;
			if (capabilities.control === "fixed") {
				assertFixedReasoningContract(model, capabilities, true);
			}
			return capabilities;
		}
		if (model.reasoningCapabilities.control === "fixed") {
			assertFixedReasoningContract(model, model.reasoningCapabilities);
		}
		return model.reasoningCapabilities;
	}

	// Legacy custom maps treated missing base levels as provider defaults. Keep
	// that behavior without weakening the exact reasoningCapabilities contract.
	if (model.thinkingLevelMap) {
		if (model.api === "mistral-conversations") {
			const effort = usesLegacyMistralReasoningEffort(model);
			return effort
				? {
						control: "effort",
						levels: {
							...LEGACY_MISTRAL_EFFORT_LEVELS,
							...model.thinkingLevelMap,
						} as ReasoningEffortLevelMap,
					}
				: {
						control: "toggle",
						levels: { ...LEGACY_MISTRAL_TOGGLE_LEVELS, ...model.thinkingLevelMap },
					};
		}
		if (model.api === "google-generative-ai" || model.api === "google-vertex") {
			return overlayLegacyGoogleLevels(getLegacyGoogleReasoningLevels(model.id), model.thinkingLevelMap);
		}
		return {
			control: "effort",
			levels: { ...LEGACY_EFFORT_LEVELS, ...model.thinkingLevelMap },
		};
	}
	if (model.api === "mistral-conversations") {
		const effort = usesLegacyMistralReasoningEffort(model);
		const levels = {
			off: effort ? "none" : "off",
			minimal: "high",
			low: "high",
			medium: "high",
			high: "high",
		};
		return effort ? { control: "effort", levels } : { control: "toggle", levels };
	}
	return { control: "effort", levels: LEGACY_EFFORT_LEVELS };
}

function resolveOpenAICompletionsThinkingFormat<TApi extends Api>(model: Model<TApi>): string {
	const explicit = (model.compat as OpenAICompletionsCompat | undefined)?.thinkingFormat;
	if (explicit) return explicit;
	if (model.provider === "deepseek" || model.baseUrl.includes("deepseek.com")) return "deepseek";
	if (model.provider === "zai" || model.baseUrl.includes("api.z.ai")) return "zai";
	if (
		model.provider === "moonshotai" ||
		model.provider === "moonshotai-cn" ||
		model.baseUrl.includes("api.moonshot.")
	) {
		return "moonshot";
	}
	if (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")) return "openrouter";
	return "openai";
}

function describeReasoningValue(value: unknown): string {
	if (typeof value === "string") return `string ${JSON.stringify(value)}`;
	return String(value);
}

/** Validate one native named-effort value before an adapter serializes it. */
export function assertValidReasoningEffortValue<TApi extends Api>(
	model: Model<TApi>,
	level: string,
	value: unknown,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(
			`Model ${model.provider}/${model.id}: effort level "${level}" must use a non-empty string; received ${describeReasoningValue(value)}.`,
		);
	}
}

function assertGoogleBudgetValue<TApi extends Api>(model: Model<TApi>, level: string, value: number): void {
	const id = model.id.toLowerCase();
	const pro = id.includes("gemini-2.5-pro");
	const flashLite = id.includes("gemini-2.5-flash-lite");
	const flash = id.includes("gemini-2.5-flash") && !flashLite;
	const robotics = id.includes("gemini-robotics-er-1.6");
	const legacyFlashLite = id.includes("gemini-2.0-flash-lite");
	const documentedBudgetModel = pro || flash || flashLite || robotics || legacyFlashLite;

	if (value === -1) {
		if (documentedBudgetModel) return;
		throw new Error(
			`Model ${model.provider}/${model.id}: reasoning budget level "${level}" uses -1, but dynamic thinking is not documented for this Google model.`,
		);
	}
	if (value === 0) {
		if (flash || flashLite || robotics || legacyFlashLite) return;
		throw new Error(
			`Model ${model.provider}/${model.id}: reasoning budget level "${level}" uses 0, but thinking cannot be disabled with a zero budget for this Google model.`,
		);
	}
	if (value < 0) {
		throw new Error(
			`Model ${model.provider}/${model.id}: reasoning budget level "${level}" must be -1, 0, or a positive integer; received ${value}.`,
		);
	}

	const minimum = pro ? 128 : flashLite ? 512 : 1;
	const maximum = pro ? 32768 : documentedBudgetModel ? 24576 : undefined;
	if (value < minimum || (maximum !== undefined && value > maximum)) {
		const range = maximum === undefined ? `at least ${minimum}` : `between ${minimum} and ${maximum}`;
		throw new Error(
			`Model ${model.provider}/${model.id}: reasoning budget level "${level}" must be ${range} tokens; received ${value}.`,
		);
	}
}

function assertReasoningBudgetOffValue<TApi extends Api>(model: Model<TApi>, value: number): void {
	if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") {
		throw new Error(
			`Model ${model.provider}/${model.id}: budget level "off" is structural for API "${model.api}"; omit levels.off and use supportsOff: true.`,
		);
	}
	if (value !== 0) {
		const detail =
			model.api === "google-generative-ai" || model.api === "google-vertex"
				? value === -1
					? "the -1 sentinel enables dynamic thinking"
					: "Google budget disable uses 0"
				: "the native budget disable value is 0";
		throw new Error(
			`Model ${model.provider}/${model.id}: budget level "off" must disable reasoning; ${detail}, received ${value}.`,
		);
	}
	if (model.api === "google-generative-ai" || model.api === "google-vertex") {
		assertGoogleBudgetValue(model, "off", value);
	}
}

function isBedrockClaudeEffortRoute<TApi extends Api>(model: Model<TApi>): boolean {
	const values = [model.id, model.name].flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
	return values.some((value) => value.includes("claude"));
}

function isBedrockNova2LiteEffortRoute<TApi extends Api>(model: Model<TApi>): boolean {
	const values = [model.id, model.name].flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
	return values.some((value) => /(?:^|-)nova-2-lite(?:-|$)/.test(value));
}

/** Validate one native numeric budget before an adapter serializes it. */
export function assertValidReasoningBudgetValue<TApi extends Api>(
	model: Model<TApi>,
	level: string,
	value: number,
): void {
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new Error(
			`Model ${model.provider}/${model.id}: budget level "${level}" must use a finite integer token value; received ${value}.`,
		);
	}
	if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "mistral-conversations"
	) {
		throw new Error(
			`Model ${model.provider}/${model.id}: API "${model.api}" accepts only string reasoning effort values and cannot serialize a numeric reasoning budget.`,
		);
	}
	if (level === "off") {
		assertReasoningBudgetOffValue(model, value);
		return;
	}
	if (model.api === "google-generative-ai" || model.api === "google-vertex") {
		assertGoogleBudgetValue(model, level, value);
		return;
	}
	const minimum = model.api === "anthropic-messages" || model.api === "bedrock-converse-stream" ? 1024 : 1;
	if (value < minimum) {
		throw new Error(
			`Model ${model.provider}/${model.id}: budget level "${level}" must be an integer of at least ${minimum} tokens; received ${value}.`,
		);
	}
}

/** Validate the effective model-aware reasoning contract before a provider builds its payload. */
export function assertValidReasoningCapabilities<TApi extends Api>(
	model: Model<TApi>,
): ModelReasoningCapabilities | undefined {
	const capabilities = getReasoningCapabilities(model);
	if (!capabilities) return undefined;
	const levels = capabilities.levels;
	const entries = Object.entries(levels).filter((entry): entry is [string, ThinkingLevelValue] => entry[1] !== null);
	if (entries.length === 0 && !(capabilities.control === "budget" && capabilities.supportsOff)) {
		throw new Error(
			`Model ${model.provider}/${model.id}: reasoningCapabilities.levels must include at least one selectable value.`,
		);
	}

	if (capabilities.control === "effort") {
		for (const [level, value] of entries) {
			assertValidReasoningEffortValue(model, level, value);
		}
		if (
			model.reasoningCapabilities?.control === "effort" &&
			model.api === "bedrock-converse-stream" &&
			!isBedrockClaudeEffortRoute(model) &&
			!isBedrockNova2LiteEffortRoute(model)
		) {
			throw new Error(
				`Model ${model.provider}/${model.id}: Bedrock effort contracts require a Claude adaptive-thinking route or Nova 2 Lite reasoningConfig route identified by the model id or name.`,
			);
		}
		if (
			model.reasoningCapabilities?.control === "effort" &&
			model.api === "bedrock-converse-stream" &&
			isBedrockNova2LiteEffortRoute(model)
		) {
			for (const [level, value] of entries) {
				if (level === "off") continue;
				if (value === "low" || value === "medium" || value === "high") continue;
				throw new Error(
					`Model ${model.provider}/${model.id}: Nova 2 Lite effort level "${level}" must map to "low", "medium", or "high"; received ${describeReasoningValue(value)}.`,
				);
			}
		}
		return capabilities;
	}

	if (capabilities.control !== "budget") return capabilities;
	if (capabilities.supportsOff && model.api !== "anthropic-messages" && model.api !== "bedrock-converse-stream") {
		throw new Error(
			`Model ${model.provider}/${model.id}: supportsOff is only valid for structural Anthropic or Bedrock budget controls.`,
		);
	}

	for (const [level, value] of entries) {
		if (typeof value !== "number") {
			throw new Error(
				`Model ${model.provider}/${model.id}: budget level "${level}" must use a numeric token value; received ${describeReasoningValue(value)}.`,
			);
		}
		assertValidReasoningBudgetValue(model, level, value);
	}

	if (model.api === "openai-completions") {
		const thinkingFormat = resolveOpenAICompletionsThinkingFormat(model);
		if (thinkingFormat !== "openai" && thinkingFormat !== "openrouter") {
			throw new Error(
				`Model ${model.provider}/${model.id}: thinkingFormat "${thinkingFormat}" cannot serialize a numeric reasoning budget; use "openai" for reasoning_budget or "openrouter" for reasoning.max_tokens.`,
			);
		}
	}

	return capabilities;
}

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	const capabilities = getReasoningCapabilities(model);
	if (!capabilities) return ["off"];
	return EXTENDED_THINKING_LEVELS.filter((level) => {
		if (level === "off" && capabilities.control === "budget" && capabilities.supportsOff) return true;
		const value = capabilities.levels[level];
		return typeof value === "string" || typeof value === "number";
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/** Resolve a requested UI level to its supported level and exact provider value. */
export function resolveThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel | undefined,
): ResolvedThinkingLevel | undefined {
	if (level === undefined) return undefined;
	const capabilities = getReasoningCapabilities(model);
	if (!capabilities) return undefined;
	const resolvedLevel = clampThinkingLevel(model, level);
	if (resolvedLevel === "off" && capabilities.control === "budget" && capabilities.supportsOff) {
		return { level: "off", enabled: false };
	}
	const providerValue = capabilities.levels[resolvedLevel];
	if (typeof providerValue !== "string" && typeof providerValue !== "number") return undefined;
	return { level: resolvedLevel, enabled: resolvedLevel !== "off", providerValue };
}

/** Resolve a provider's native off value without overriding an explicit capability contract. */
export function resolveThinkingOffValue<TApi extends Api>(
	model: Model<TApi>,
	contractlessValue: ThinkingLevelValue,
): ThinkingLevelValue | undefined {
	if (!model.reasoning) return undefined;
	if (model.reasoningCapabilities) {
		const value = getReasoningCapabilities(model)?.levels.off;
		return typeof value === "string" || typeof value === "number" ? value : undefined;
	}

	const legacyValue = model.thinkingLevelMap?.off;
	if (legacyValue === null) return undefined;
	return typeof legacyValue === "string" || typeof legacyValue === "number" ? legacyValue : contractlessValue;
}

/** Resolve an explicit simple-stream selection. Omission preserves the provider/model default. */
export function resolveSimpleThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel | undefined,
): ResolvedThinkingLevel | undefined {
	return resolveThinkingLevel(model, level);
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
