import { MODELS } from "./models.generated.js";
import type {
	Api,
	KnownProvider,
	Model,
	ModelReasoningCapabilities,
	ModelThinkingLevel,
	ThinkingLevelValue,
	Usage,
} from "./types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
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
	return (
		model.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		(model.id === "gpt-5.4" || model.id === "gpt-5.5" || model.id === "gpt-5.6" || model.id.startsWith("gpt-5.6-"))
	);
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

const LEGACY_TOGGLE_CAPABILITIES: ModelReasoningCapabilities = {
	control: "toggle",
	levels: { off: "off", high: "high" },
};

export interface ResolvedThinkingLevel {
	level: ModelThinkingLevel;
	enabled: boolean;
	providerValue: ThinkingLevelValue;
}

/** Return the route's single authoritative reasoning capability contract. */
export function getReasoningCapabilities<TApi extends Api>(model: Model<TApi>): ModelReasoningCapabilities | undefined {
	if (!model.reasoning) return undefined;
	if (model.reasoningCapabilities) return model.reasoningCapabilities;

	// Custom models created before reasoningCapabilities existed remain usable,
	// but a missing map is deliberately conservative rather than advertising
	// every generic effort name.
	if (model.thinkingLevelMap) {
		return { control: "effort", levels: model.thinkingLevelMap };
	}
	return LEGACY_TOGGLE_CAPABILITIES;
}

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	const capabilities = getReasoningCapabilities(model);
	if (!capabilities) return ["off"];
	return EXTENDED_THINKING_LEVELS.filter((level) => {
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
		const value = model.reasoningCapabilities.levels.off;
		return typeof value === "string" || typeof value === "number" ? value : undefined;
	}

	const legacyValue = model.thinkingLevelMap?.off;
	if (legacyValue === null) return undefined;
	return typeof legacyValue === "string" || typeof legacyValue === "number" ? legacyValue : contractlessValue;
}

/** Resolve a simple-stream selection, defaulting to off only when the route exposes a native off value. */
export function resolveSimpleThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel | undefined,
): ResolvedThinkingLevel | undefined {
	if (level !== undefined) return resolveThinkingLevel(model, level);
	const offValue = getReasoningCapabilities(model)?.levels.off;
	if (typeof offValue !== "string" && typeof offValue !== "number") return undefined;
	return { level: "off", enabled: false, providerValue: offValue };
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
