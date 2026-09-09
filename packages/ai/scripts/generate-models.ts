#!/usr/bin/env tsx

import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getAnthropicCacheCosts } from "../src/cache-pricing.js";
import { COPILOT_CLIENT_HEADERS } from "../src/copilot-client-version.js";
import { assertValidReasoningCapabilities } from "../src/models.js";
import { getOpenRouterReasoningCapabilities } from "../src/openrouter-reasoning.js";
import {
	isPrivatePrimeInferenceModelId,
	parsePrimeInferenceModelCatalog,
	type PrimeInferenceCatalogEntry,
} from "../src/prime-inference-model-catalog.js";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
} from "../src/providers/cloudflare.js";
import {
	Api,
	type AnthropicMessagesCompat,
	KnownProvider,
	Model,
	type ModelReasoningCapabilities,
	type OpenAICompletionsCompat,
	type ReasoningBudgetLevelMap,
	type ReasoningEffortLevelMap,
	type ThinkingLevelMap,
} from "../src/types.js";
import { MODELS as EXISTING_MODELS } from "../src/models.generated.js";
import { renderModelsFile } from "./render-models.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	reasoning?: boolean;
	interleaved?: {
		field?: string;
	};
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
	provider?: {
		npm?: string;
	};
}

interface AiGatewayReasoningOption {
	type: string;
	values?: string[];
	min?: number;
	max?: number;
}

interface AiGatewayModel {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	reasoning_options?: AiGatewayReasoningOption[];
	pricing?: {
		input?: string | number;
		output?: string | number;
		input_cache_read?: string | number;
		input_cache_write?: string | number;
	};
}

const COPILOT_STATIC_HEADERS = COPILOT_CLIENT_HEADERS;

const KIMI_STATIC_HEADERS = {
	"User-Agent": "KimiCLI/1.5",
} as const;

const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1";
const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const ZAI_TOOL_STREAM_UNSUPPORTED_MODELS = new Set(["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5v"]);
const EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS = new Set([
	"github-copilot:claude-haiku-4.5",
	"github-copilot:claude-sonnet-4",
	"github-copilot:claude-sonnet-4.5",
]);

const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	off: "off",
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;

const ZAI_TOGGLE_THINKING_LEVEL_MAP = {
	off: "off",
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: null,
} as const;

const ZAI_GLM_52_THINKING_LEVEL_MAP = {
	...ZAI_TOGGLE_THINKING_LEVEL_MAP,
	max: "max",
} as const;

const KIMI_K3_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: "max",
} as const;

const FIREWORKS_ANTHROPIC_BUDGET_LEVEL_MAP = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 65536,
} as const;

const KIMI_CODING_K3_EFFORT_LEVEL_MAP = {
	off: "none",
	minimal: "low",
	low: "low",
	medium: "high",
	high: "high",
	xhigh: "max",
	max: "max",
} as const;

const BEDROCK_NOVA_2_LITE_REASONING_LEVEL_MAP = {
	off: "off",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
} as const;

const MOONSHOT_K2_TOGGLE_LEVEL_MAP = {
	off: "disabled",
	minimal: null,
	low: null,
	medium: null,
	high: "enabled",
	xhigh: null,
	max: null,
} as const;

const MOONSHOT_K3_EFFORT_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;

const FIXED_REASONING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "always",
	xhigh: null,
	max: null,
} as const;

// GitHub's configurable-reasoning table is authoritative for Copilot routes:
// https://docs.github.com/en/copilot/reference/ai-models/supported-models#models-with-extended-capabilities
const GITHUB_COPILOT_CONFIGURABLE_REASONING_MODELS = new Set([
	"claude-fable-5",
	"claude-opus-4.6",
	"claude-opus-4.7",
	"claude-opus-4.8",
	"claude-opus-4.8-fast",
	"claude-opus-5",
	"claude-sonnet-4.6",
	"claude-sonnet-5",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

const DEEPSEEK_V4_COMPAT: OpenAICompletionsCompat = {
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
};

const ZAI_THINKING_COMPAT: OpenAICompletionsCompat = {
	supportsReasoningEffort: false,
	thinkingFormat: "zai",
};

const PRIME_INFERENCE_BASE_URL = "https://api.pinference.ai/api/v1";
const PRIME_INFERENCE_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
};
interface PrimeInferenceModelMetadata {
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	name?: string;
}

// Prime's /models endpoint is authoritative for route metadata. OpenRouter and
// these overrides only fill gaps for older or incomplete endpoint entries;
// requests always go to Prime's own baseUrl.
const PRIME_INFERENCE_MODEL_METADATA: Record<string, PrimeInferenceModelMetadata> = {
	// These routes accept 200k, checked against the live API 2026-07-08. The
	// other Claude routes take the full window their spec lists.
	"anthropic/claude-sonnet-4": { contextWindow: 200000 },
	"anthropic/claude-sonnet-4.5": { contextWindow: 200000 },
	// Windows confirmed against the live API 2026-07-08 where they are SMALLER
	// than the published spec — over-declaring breaks context tracking.
	"meta-llama/llama-3.2-1b-instruct": { contextWindow: 60000 },
	"meta-llama/llama-3.2-3b-instruct": { contextWindow: 80000 },
	"minimax/minimax-m3": { contextWindow: 524288 },
	"moonshotai/kimi-k2-0905": { contextWindow: 98304 },
	"nvidia/nemotron-3-super-120b-a12b": { contextWindow: 262144, maxTokens: 4096 },
	// Enforced window is LARGER than OpenRouter's listing.
	"qwen/qwen3-30b-a3b-instruct-2507": { contextWindow: 262144 },
	// OpenRouter has no max_completion_tokens for the rest of these.
	"moonshotai/kimi-k2.5": { maxTokens: 65535 },
	"minimax/minimax-m2.7": { maxTokens: 131072 },
	// models.dev (moonshotai + openrouter) both list output = context for k2.6.
	"moonshotai/kimi-k2.6": { maxTokens: 262144 },
	"moonshotai/kimi-k3": { maxTokens: 1048576 },
	"openai/gpt-4.1": { maxTokens: 32768 },
	"openai/gpt-5-nano": { maxTokens: 128000 },
	"openai/gpt-oss-20b": { maxTokens: 131072 },
	"qwen/qwen3.5-397b-a17b": { maxTokens: 65536 },
	"x-ai/grok-4.20": { maxTokens: 30000 },
	"x-ai/grok-4.20-multi-agent": { maxTokens: 30000 },
	"xiaomi/mimo-v2.5": { maxTokens: 131072 },
	"z-ai/glm-5": { maxTokens: 131072 },
};

// Flagship models pinned above the long tail in the model picker, so the full
// catalog doesn't flood /model. Everything else stays selectable via search.
const PRIME_INFERENCE_FEATURED_MODELS = new Set([
	"anthropic/claude-fable-5",
	"anthropic/claude-haiku-4.5",
	"anthropic/claude-opus-4.6",
	"anthropic/claude-opus-4.7",
	"anthropic/claude-opus-4.8",
	"anthropic/claude-sonnet-4.5",
	"anthropic/claude-sonnet-4.6",
	"anthropic/claude-sonnet-5",
	"deepseek/deepseek-v3.2",
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-pro",
	"minimax/minimax-m3",
	"moonshotai/kimi-k2.7-code",
	"moonshotai/kimi-k3",
	"nvidia/nemotron-3-nano-30b-a3b",
	"nvidia/nemotron-3-super-120b-a12b",
	"openai/gpt-5.3-codex",
	"openai/gpt-5.4",
	"openai/gpt-5.4-mini",
	"openai/gpt-5.4-pro",
	"openai/gpt-5.5",
	"qwen/qwen3-30b-a3b-instruct-2507",
	"qwen/qwen3-coder-next",
	"qwen/qwen3-max",
	"qwen/qwen3-vl-235b-a22b-thinking",
	"qwen/qwen3.8-max",
	"x-ai/grok-4.20",
	"x-ai/grok-4.20-multi-agent",
	"z-ai/glm-5",
	"z-ai/glm-5.1",
	"z-ai/glm-5.2",
]);

// Prime ids whose OpenRouter listing uses a different id (e.g. after an
// OpenRouter route rename); metadata lookups resolve through this mapping.
const PRIME_INFERENCE_OPENROUTER_ALIASES: Record<string, string> = {
	// OpenRouter renamed its route to the dated id; Prime still serves the undated one.
	"qwen/qwen3.8-max": "qwen/qwen3.8-max-0902",
};

// Conservative fallbacks for catalog models with no OpenRouter match and no
// override above: an under-declared window degrades gracefully, an
// over-declared one breaks context tracking.
const PRIME_INFERENCE_DEFAULT_CONTEXT_WINDOW = 128000;
const PRIME_INFERENCE_DEFAULT_MAX_TOKENS = 8192;

const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"gpt-5.6",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

function mergeThinkingLevelMap(model: Model<any>, map: NonNullable<Model<any>["thinkingLevelMap"]>): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

function syncLegacyThinkingLevelMap(model: Model<any>): void {
	if (!model.reasoningCapabilities) return;
	if (model.reasoningCapabilities.control === "budget") {
		delete model.thinkingLevelMap;
		return;
	}
	model.thinkingLevelMap = { ...model.reasoningCapabilities.levels };
}

function replaceReasoningOffValue(model: Model<any>, off: string | number | null): void {
	if (!model.reasoningCapabilities) return;
	model.reasoningCapabilities = {
		...model.reasoningCapabilities,
		levels: { ...model.reasoningCapabilities.levels, off },
	};
	syncLegacyThinkingLevelMap(model);
}

function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6")
	);
}

function getOpenAiReasoningLevelMap(modelId: string): Model<any>["thinkingLevelMap"] | undefined {
	const id = modelId.toLowerCase();
	if (!id.includes("gpt-5") && !id.includes("gpt-oss") && !/^o[134](?:-|$)/.test(id)) return undefined;
	if (id.includes("gpt-oss")) {
		return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}
	if (id.includes("gpt-5-pro") || id === "gpt-5-pro") {
		return { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null };
	}
	if (/gpt-5\.(?:2|4|5)-pro/.test(id)) {
		return { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: null };
	}
	if (id.includes("gpt-5.6")) {
		return { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
	}
	if (/(?:^|\/)gpt-5-(?:mini|nano)(?:-|$)/.test(id)) {
		return { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}
	if (/gpt-5\.[1-5]/.test(id)) {
		return {
			off: OPENAI_RESPONSES_NONE_REASONING_MODELS.has(modelId) ? "none" : null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: supportsOpenAiXhigh(id) ? "xhigh" : null,
			max: null,
		};
	}
	if (id === "gpt-5" || id.endsWith("/gpt-5")) {
		return { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}
	return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
}

function getDocumentedOpenAiCompatibleLevelMap(model: Model<any>): Model<any>["thinkingLevelMap"] | undefined {
	const id = model.id.toLowerCase();
	if (model.provider === "xai") {
		if (id.includes("grok-4.6") || id.includes("grok-4.20-multi-agent")) {
			return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null };
		}
		if (id.includes("grok-4.5")) {
			return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
		}
	}
	if (model.provider === "groq") {
		if (id.includes("gpt-oss")) return getOpenAiReasoningLevelMap(id);
		if (id.includes("qwen")) return { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null };
	}
	if (model.provider === "cerebras") {
		if (id.includes("gpt-oss")) return getOpenAiReasoningLevelMap(id);
		if (id.includes("glm") || id.includes("gemma")) {
			return { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null };
		}
	}
	return undefined;
}

function isGoogleThinkingApi(model: Model<any>): boolean {
	return model.api === "google-generative-ai" || model.api === "google-vertex";
}

function hasNumericReasoningLevels(levels: ModelReasoningCapabilities["levels"] | undefined): boolean {
	return Object.values(levels ?? {}).some((value) => typeof value === "number");
}

function getGoogleBudgetLevelMap(modelId: string): ReasoningBudgetLevelMap | undefined {
	if (isGemini25ProModel(modelId)) {
		return { off: null, minimal: 128, low: 2048, medium: 8192, high: 32768, xhigh: null, max: null };
	}
	if (isGemini25FlashModel(modelId)) {
		return { off: 0, minimal: 128, low: 2048, medium: 8192, high: 24576, xhigh: null, max: null };
	}
	if (isGemini25FlashLiteModel(modelId)) {
		return { off: 0, minimal: 512, low: 2048, medium: 8192, high: 24576, xhigh: null, max: null };
	}
	return undefined;
}

function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function supportsGemini3ProMedium(modelId: string): boolean {
	return /gemini-3\.(?:[1-9]\d*)-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-flash/.test(modelId.toLowerCase());
}

function isGemini35FlashLiteAlias(modelId: string): boolean {
	return modelId.toLowerCase() === "gemini-flash-lite-latest";
}

function isGemini37OrLaterFlashModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	if (id === "gemini-flash-latest") return true;
	const match = /^gemini-3\.(\d+)-flash(?:-\d{3}|-preview(?:-\d{2}-\d{4})?)?$/i.exec(id);
	if (match) {
		const minor = Number.parseInt(match[1], 10);
		return minor >= 7;
	}
	return false;
}

function getGeminiFlashThinkingLevelMap(modelId: string): Model<any>["thinkingLevelMap"] | undefined {
	if (
		!isGemini3FlashModel(modelId) &&
		!isGemini35FlashLiteAlias(modelId) &&
		!isGemini37OrLaterFlashModel(modelId)
	) {
		return undefined;
	}
	return {
		off: null,
		minimal: isGemini37OrLaterFlashModel(modelId) ? null : "MINIMAL",
		low: "LOW",
		medium: "MEDIUM",
		high: "HIGH",
		xhigh: null,
		max: null,
	};
}

function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

function isGemini25ProModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("gemini-2.5-pro");
}

function isGemini25FlashLiteModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("gemini-2.5-flash-lite");
}

function isGemini25FlashModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("gemini-2.5-flash") && !isGemini25FlashLiteModel(modelId);
}

function isAdaptiveClaudeModel(modelId: string, modelName?: string): boolean {
	const candidates = (modelName ? [modelId, modelName] : [modelId]).flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
	return candidates.some(
		(candidate) =>
			candidate.includes("opus-4-6") ||
			candidate.includes("opus-4-7") ||
			candidate.includes("opus-4-8") ||
			candidate.includes("opus-5") ||
			candidate.includes("sonnet-4-6") ||
			candidate.includes("sonnet-5") ||
			candidate.includes("fable-5") ||
			candidate.includes("mythos"),
	);
}

function isNativeAnthropicClaudeRoute(model: Model<any>): boolean {
	if (model.api !== "anthropic-messages") return false;
	const claudeRoute = model.id.toLowerCase().includes("claude") || model.name.toLowerCase().includes("claude");
	return (
		claudeRoute &&
		(model.provider === "anthropic" ||
			model.provider === "github-copilot" ||
			model.provider === "opencode" ||
			model.provider === "cloudflare-ai-gateway" ||
			model.provider === "vercel-ai-gateway")
	);
}

function isMistralReasoningEffortModel(modelId: string): boolean {
	return (
		modelId === "mistral-small-2603" ||
		modelId === "mistral-small-latest" ||
		modelId === "mistral-medium-3.5" ||
		modelId === "mistral-medium-3-5" ||
		modelId === "mistral-medium-2604" ||
		modelId === "mistral-medium-latest"
	);
}

function isNativeMagistralReasoningModel(model: Model<any>): boolean {
	return (
		model.api === "mistral-conversations" &&
		/^magistral-(?:small|medium)(?:-|$)/.test(model.id.toLowerCase())
	);
}

function isBedrockNova2LiteModel(model: Model<any>): boolean {
	return model.api === "bedrock-converse-stream" && /(?:^|[.])nova-2-lite(?:-|$)/.test(model.id.toLowerCase());
}

function isNativeMoonshotModel(model: Model<any>): boolean {
	return (
		model.api === "openai-completions" &&
		(model.provider === "moonshotai" || model.provider === "moonshotai-cn")
	);
}

function isAudnK3EffortModel(model: Model<any>): boolean {
	return (
		model.api === "openai-completions" &&
		model.provider === "audn" &&
		(model.id === "necromicon" || model.id === "k3-thinker-qwen38")
	);
}

function applyProviderSpecificReasoningMetadata(model: Model<any>): boolean {
	let control: "fixed" | "toggle" | "effort" | "budget" | undefined;
	let levels: ThinkingLevelMap | ReasoningBudgetLevelMap | undefined;

	if (model.api === "anthropic-messages" && model.provider === "fireworks") {
		control = "budget";
		levels = { ...FIREWORKS_ANTHROPIC_BUDGET_LEVEL_MAP };
	} else if (model.api === "anthropic-messages" && model.provider === "kimi-coding") {
		const kimiK3 = /^k3(?:-|$)/.test(model.id.toLowerCase());
		control = kimiK3 ? "effort" : "budget";
		levels = kimiK3 ? { ...KIMI_CODING_K3_EFFORT_LEVEL_MAP } : { ...FIREWORKS_ANTHROPIC_BUDGET_LEVEL_MAP };
	} else if (isBedrockNova2LiteModel(model)) {
		control = "effort";
		levels = { ...BEDROCK_NOVA_2_LITE_REASONING_LEVEL_MAP };
	} else if (isNativeMoonshotModel(model) && /^kimi-k2\.(?:5|6)(?:-|$)/.test(model.id.toLowerCase())) {
		control = "toggle";
		levels = { ...MOONSHOT_K2_TOGGLE_LEVEL_MAP };
		model.compat = {
			...model.compat,
			supportsReasoningEffort: false,
			thinkingFormat: "moonshot",
		};
	} else if (isNativeMoonshotModel(model) && /^kimi-k3(?:-|$)/.test(model.id.toLowerCase())) {
		control = "effort";
		levels = { ...MOONSHOT_K3_EFFORT_LEVEL_MAP };
		model.compat = {
			...model.compat,
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		};
	} else if (isAudnK3EffortModel(model)) {
		control = "effort";
		levels = { ...MOONSHOT_K3_EFFORT_LEVEL_MAP };
		model.compat = {
			...model.compat,
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		};
	} else if (isNativeMagistralReasoningModel(model)) {
		control = "fixed";
		levels = { ...FIXED_REASONING_LEVEL_MAP };
	}

	if (!control || !levels) return false;
	model.reasoningCapabilities =
		control === "budget"
			? { control, levels: { ...levels } as ReasoningBudgetLevelMap, supportsOff: true }
			: control === "effort"
				? { control, levels: { ...levels } as ReasoningEffortLevelMap }
				: { control, levels: { ...levels } as ThinkingLevelMap };
	syncLegacyThinkingLevelMap(model);
	return true;
}

function isOpenRouterDeepSeekV4Route(model: Model<any>): boolean {
	return (
		model.provider === "openrouter" &&
		model.api === "openai-completions" &&
		model.id.toLowerCase().includes("deepseek-v4")
	);
}

function isPrimeDeepSeekV4Route(model: Model<any>): boolean {
	return (
		model.provider === "prime-inference" &&
		model.api === "openai-completions" &&
		model.id.toLowerCase().includes("deepseek-v4")
	);
}

// Snapshot of the per-alias reasoning schema published by OpenRouter. Preserve
// mode cannot refetch the catalog, so feed the published fields through the
// same parser used by live generation instead of borrowing DeepSeek's direct
// API contract.
const OPENROUTER_DEEPSEEK_V4_REASONING_SCHEMA: Record<string, unknown> = {
	"deepseek/deepseek-v4-flash": {
		supported_parameters: ["reasoning"],
		reasoning: { mandatory: false, supported_efforts: ["xhigh", "high"] },
	},
	"deepseek/deepseek-v4-pro": {
		supported_parameters: ["reasoning"],
		reasoning: { mandatory: false, supported_efforts: ["xhigh", "high"] },
	},
	"deepseek/deepseek-v4-pro-0813": {
		supported_parameters: ["reasoning"],
		reasoning: { mandatory: false, supported_efforts: ["max", "high", "low"] },
	},
	"deepseek/deepseek-v4-flash-0731": {
		supported_parameters: ["reasoning"],
		reasoning: { mandatory: false, supported_efforts: ["max", "high", "low"] },
	},
	"~deepseek/deepseek-v4-flash-latest": {
		supported_parameters: ["reasoning"],
		reasoning: { mandatory: false, supported_efforts: ["max", "high", "low"] },
	},
};

function applyOpenRouterDeepSeekV4Compat(model: Model<any>): void {
	const compat = { ...model.compat };
	delete compat.requiresReasoningContentOnAssistantMessages;
	model.compat = {
		...compat,
		supportsReasoningEffort: true,
		thinkingFormat: "openrouter",
	};
}

function refreshPreservedOpenRouterDeepSeekV4Reasoning(model: Model<any>): void {
	applyOpenRouterDeepSeekV4Compat(model);
	const schema = OPENROUTER_DEEPSEEK_V4_REASONING_SCHEMA[model.id.toLowerCase()];
	const parsed = getOpenRouterReasoningCapabilities(schema);
	if (!parsed?.thinkingLevelMap) return;

	model.thinkingLevelMap = { ...parsed.thinkingLevelMap };
	model.reasoningCapabilities = {
		control: parsed.supportsReasoningEffort ? "effort" : "toggle",
		levels: { ...parsed.thinkingLevelMap },
	};
}

function refreshPrimeDeepSeekV4Reasoning(model: Model<any>): void {
	const schema = OPENROUTER_DEEPSEEK_V4_REASONING_SCHEMA[model.id.toLowerCase()];
	const parsed = getOpenRouterReasoningCapabilities(schema);
	if (!parsed?.thinkingLevelMap) return;

	model.thinkingLevelMap = { ...parsed.thinkingLevelMap };
	model.reasoningCapabilities = {
		control: parsed.supportsReasoningEffort ? "effort" : "toggle",
		levels: { ...parsed.thinkingLevelMap },
	};
	model.compat = {
		...model.compat,
		supportsReasoningEffort: parsed.supportsReasoningEffort,
	};
}

function isPrimeGpt56Route(model: Model<any>): boolean {
	return (
		model.provider === "prime-inference" &&
		model.api === "openai-completions" &&
		/(?:^|\/)gpt-5\.6(?:-|$)/.test(model.id.toLowerCase())
	);
}

function applyThinkingLevelMetadata(model: Model<any>): void {
	if (!model.reasoning) {
		delete model.thinkingLevelMap;
		delete model.reasoningCapabilities;
		return;
	}
	if (applyProviderSpecificReasoningMetadata(model)) return;
	if (
		model.provider === "github-copilot" &&
		!GITHUB_COPILOT_CONFIGURABLE_REASONING_MODELS.has(model.id.toLowerCase())
	) {
		model.thinkingLevelMap = { ...FIXED_REASONING_LEVEL_MAP };
		model.reasoningCapabilities = { control: "fixed", levels: { ...FIXED_REASONING_LEVEL_MAP } };
		return;
	}
	if (
		model.id.includes("muse-spark-1.3") ||
		model.id.includes("muse-spark-1.3-contributor")
	) {
		const parsedLevels = model.thinkingLevelMap ?? {};
		const museSparkLevels = {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			...parsedLevels,
			max: null,
		};
		model.thinkingLevelMap = { ...museSparkLevels };
		model.reasoningCapabilities = { control: "effort", levels: { ...museSparkLevels } };
		if (model.compat) {
			model.compat.supportsReasoningEffort = true;
		}
		return;
	}
	if (model.reasoningCapabilities) return;
	if (isOpenRouterDeepSeekV4Route(model)) {
		applyOpenRouterDeepSeekV4Compat(model);
	}
	if (isPrimeDeepSeekV4Route(model)) {
		refreshPrimeDeepSeekV4Reasoning(model);
	}
	if (
		model.api === "openai-completions" &&
		(model.provider === "opencode" || model.provider === "opencode-go") &&
		model.id.toLowerCase().includes("deepseek")
	) {
		model.compat = {
			...model.compat,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
			...(!model.id.toLowerCase().includes("deepseek-v4") ? { supportsReasoningEffort: false } : {}),
		};
		model.thinkingLevelMap = { ...FIXED_REASONING_LEVEL_MAP };
		model.reasoningCapabilities = { control: "fixed", levels: { ...FIXED_REASONING_LEVEL_MAP } };
		return;
	}

	const nativeOpenAiRoute =
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses";
	const nativeAnthropicRoute =
		isNativeAnthropicClaudeRoute(model) ||
		(model.api === "bedrock-converse-stream" &&
			(model.id.toLowerCase().includes("claude") || model.name.toLowerCase().includes("claude")));
	const openAiReasoningLevelMap = getOpenAiReasoningLevelMap(model.id);
	if (openAiReasoningLevelMap && nativeOpenAiRoute) {
		mergeThinkingLevelMap(model, openAiReasoningLevelMap);
	}
	const compatibleReasoningLevelMap = getDocumentedOpenAiCompatibleLevelMap(model);
	if (compatibleReasoningLevelMap) {
		mergeThinkingLevelMap(model, compatibleReasoningLevelMap);
		if (model.provider === "xai") {
			model.compat = { ...model.compat, supportsReasoningEffort: true };
		}
	}
	if (
		model.api === "openai-responses" &&
		model.provider === "openai" &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	if (model.api === "openai-responses" && model.provider === "github-copilot") {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (nativeOpenAiRoute && supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (nativeOpenAiRoute && model.id.includes("gpt-5.6")) {
		mergeThinkingLevelMap(model, { minimal: null, max: "max" });
	}
	// gpt-6 reasoning is mandatory with no minimal effort; xhigh/max are supported (OpenRouter capability data).
	if (model.id.includes("gpt-6")) {
		mergeThinkingLevelMap(model, { minimal: null, xhigh: "xhigh", max: "max" });
	}
	if (
		(model.api === "openai-responses" ||
			model.api === "azure-openai-responses" ||
			model.api === "openai-codex-responses") &&
		model.id.startsWith("gpt-6")
	) {
		mergeThinkingLevelMap(model, { off: null });
	}
	// Per-family effort support per the Anthropic effort docs. Opus 4.6 / Sonnet 4.6
	// have no xhigh; Fable 5 / Mythos 5 / Mythos Preview think every turn (off: null).
	if (
		nativeAnthropicRoute &&
		(model.id.includes("opus-4-6") ||
			model.id.includes("opus-4.6") ||
			model.id.includes("sonnet-4-6") ||
			model.id.includes("sonnet-4.6"))
	) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (
		nativeAnthropicRoute &&
		(model.id.includes("opus-4-7") ||
			model.id.includes("opus-4.7") ||
			model.id.includes("opus-4-8") ||
			model.id.includes("opus-4.8") ||
			model.id.includes("opus-5") ||
			model.id.includes("sonnet-5"))
	) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
	}
	if (nativeAnthropicRoute && (model.id.includes("fable-5") || model.id.includes("mythos-5"))) {
		mergeThinkingLevelMap(model, { off: null, xhigh: "xhigh", max: "max" });
	}
	if (nativeAnthropicRoute && model.id.includes("mythos-preview")) {
		mergeThinkingLevelMap(model, { off: null, max: "max" });
	}
	if (model.provider === "deepseek" && model.api === "openai-completions" && model.id.includes("deepseek-v4")) {
		mergeThinkingLevelMap(model, DEEPSEEK_V4_THINKING_LEVEL_MAP);
	}
	if (model.compat?.thinkingFormat === "zai" && model.reasoning) {
		const supportsEffort = /(?:^|\/)glm-5\.2(?:-|$)/.test(model.id.toLowerCase());
		mergeThinkingLevelMap(
			model,
			supportsEffort ? ZAI_GLM_52_THINKING_LEVEL_MAP : ZAI_TOGGLE_THINKING_LEVEL_MAP,
		);
		model.compat = { ...model.compat, supportsReasoningEffort: supportsEffort };
	}
	const kimiK3Id = model.id.toLowerCase();
	if (
		model.api === "openai-completions" &&
		model.compat?.supportsReasoningEffort === true &&
		(/^k3(-|$)/.test(kimiK3Id) || /(^|\/)kimi-k3(-|$)/.test(kimiK3Id))
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	if (!model.thinkingLevelMap && (/^k3(-|$)/.test(kimiK3Id) || /(^|\/)kimi-k3(-|$)/.test(kimiK3Id))) {
		mergeThinkingLevelMap(model, KIMI_K3_THINKING_LEVEL_MAP);
	}
	if (isGoogleThinkingApi(model) && isGemini3ProModel(model.id)) {
		mergeThinkingLevelMap(model, {
			off: null,
			minimal: null,
			low: "LOW",
			medium: supportsGemini3ProMedium(model.id) ? "MEDIUM" : null,
			high: "HIGH",
			xhigh: null,
			max: null,
		});
	}
	const geminiFlashThinkingLevelMap = getGeminiFlashThinkingLevelMap(model.id);
	if (isGoogleThinkingApi(model) && geminiFlashThinkingLevelMap) {
		mergeThinkingLevelMap(model, geminiFlashThinkingLevelMap);
	}
	if (isGoogleThinkingApi(model) && isGemma4Model(model.id)) {
		mergeThinkingLevelMap(model, { off: "MINIMAL", minimal: null, low: null, medium: null, high: "HIGH" });
	}
	if (
		model.provider === "openai-codex" &&
		supportsOpenAiXhigh(model.id) &&
		!model.id.includes("gpt-5.6")
	) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (model.provider === "openai-codex" && model.id === "gpt-5.1-codex-mini") {
		mergeThinkingLevelMap(model, { minimal: "medium", low: "medium", medium: "medium", high: "high" });
	}
	if (model.api === "mistral-conversations" && isMistralReasoningEffortModel(model.id)) {
		mergeThinkingLevelMap(model, {
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	}

	const isClaudeBedrock =
		model.api === "bedrock-converse-stream" &&
		(model.id.toLowerCase().includes("claude") || model.name.toLowerCase().includes("claude"));
	const directClaudeApi = isNativeAnthropicClaudeRoute(model);
	const googleThinking = model.api === "google-generative-ai" || model.api === "google-vertex";
	const adaptiveClaude = (directClaudeApi || isClaudeBedrock) && isAdaptiveClaudeModel(model.id, model.name);
	const budgetBased = (directClaudeApi || isClaudeBedrock) && !adaptiveClaude;
	const namedEffort =
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses";
	const openAiCompat = model.api === "openai-completions" ? model.compat : undefined;
	const openAiToggleFormat =
		model.provider === "openrouter" ||
		openAiCompat?.thinkingFormat === "zai" ||
		openAiCompat?.thinkingFormat === "qwen" ||
		openAiCompat?.thinkingFormat === "qwen-chat-template" ||
		openAiCompat?.thinkingFormat === "deepseek" ||
		openAiCompat?.thinkingFormat === "openrouter";
	const hasKnownReasoningControl =
		adaptiveClaude ||
		budgetBased ||
		namedEffort ||
		googleThinking ||
		openAiToggleFormat ||
		model.api === "mistral-conversations" ||
		model.thinkingLevelMap !== undefined;
	const fixedReasoning =
		(model.api === "bedrock-converse-stream" && !isClaudeBedrock && !model.thinkingLevelMap) ||
		(model.api === "anthropic-messages" && !directClaudeApi && !model.thinkingLevelMap) ||
		(model.api === "openai-completions" && model.provider === "xai" && !compatibleReasoningLevelMap) ||
		(model.api === "openai-completions" &&
			(model.provider === "cloudflare-workers-ai" ||
				(model.provider === "cloudflare-ai-gateway" && model.id.startsWith("workers-ai/")))) ||
		(model.api === "openai-completions" &&
			(model.provider === "huggingface" || model.provider === "fireworks") &&
			!model.thinkingLevelMap) ||
		(model.api === "openai-completions" &&
			openAiCompat?.supportsReasoningEffort === false &&
			!openAiToggleFormat) ||
		!hasKnownReasoningControl;
	const defaultLevels = adaptiveClaude
		? { off: "off", low: "low", medium: "medium", high: "high" }
		: budgetBased
			? { minimal: 1024, low: 2048, medium: 8192, high: 16384 }
			: namedEffort
				? { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" }
				: googleThinking
					? { off: 0, high: -1 }
					: fixedReasoning
						? { off: null, high: "always" }
						: { off: "off", high: "high" };
	const supportsNamedEffort =
		namedEffort ||
		adaptiveClaude ||
		openAiCompat?.supportsReasoningEffort === true ||
		((openAiCompat?.thinkingFormat === "deepseek" || openAiCompat?.thinkingFormat === "openrouter") &&
			openAiCompat.supportsReasoningEffort !== false) ||
		Object.entries(model.thinkingLevelMap ?? {}).filter(
			([level, value]) => level !== "off" && value !== null && value !== undefined,
		).length > 1 ||
		(model.api === "mistral-conversations" && !!model.thinkingLevelMap) ||
		(googleThinking && !!model.thinkingLevelMap && !hasNumericReasoningLevels(model.thinkingLevelMap));
	const googleBudgetLevels = googleThinking ? getGoogleBudgetLevelMap(model.id) : undefined;
	const reasoningLevels = googleBudgetLevels ?? { ...defaultLevels, ...model.thinkingLevelMap };
	model.reasoningCapabilities = fixedReasoning
		? { control: "fixed", levels: { off: null, high: "always" } }
		: budgetBased || (googleThinking && hasNumericReasoningLevels(reasoningLevels))
			? {
					control: "budget",
					levels: reasoningLevels as ReasoningBudgetLevelMap,
					...(budgetBased ? { supportsOff: true } : {}),
				}
			: supportsNamedEffort
				? { control: "effort", levels: reasoningLevels as ReasoningEffortLevelMap }
				: { control: "toggle", levels: reasoningLevels };
	// Keep the deprecated string map for named controls only. Numeric budgets
	// live exclusively in reasoningCapabilities.
	syncLegacyThinkingLevelMap(model);
}

function getAnthropicMessagesCompat(provider: string, modelId: string): AnthropicMessagesCompat | undefined {
	return EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)
		? { supportsEagerToolInputStreaming: false }
		: undefined;
}

function getBedrockBaseUrl(modelId: string): string {
	if (modelId.startsWith("eu.")) return "https://bedrock-runtime.eu-central-1.amazonaws.com";
	if (modelId.startsWith("au.")) return "https://bedrock-runtime.ap-southeast-2.amazonaws.com";
	if (modelId.startsWith("jp.")) return "https://bedrock-runtime.ap-northeast-1.amazonaws.com";
	return "https://bedrock-runtime.us-east-1.amazonaws.com";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getPrimeInferenceCacheCosts(modelId: string, inputCost: number): { cacheRead: number; cacheWrite: number } {
	return modelId.toLowerCase().startsWith("anthropic/")
		? getAnthropicCacheCosts(inputCost, "5m")
		: { cacheRead: 0, cacheWrite: 0 };
}

function getExistingPrimeInferenceModels(): Model<"openai-completions">[] {
	const models = EXISTING_MODELS["prime-inference"] as unknown as Record<string, Model<"openai-completions">>;
	return Object.values(models)
		.filter((model) => !isPrivatePrimeInferenceModelId(model.id))
		.map((model) => ({
			...model,
			input: [...model.input],
			cost: {
				...model.cost,
				...getPrimeInferenceCacheCosts(model.id, model.cost.input),
			},
			...(model.compat ? { compat: { ...model.compat } } : {}),
			...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
			...(model.headers ? { headers: { ...model.headers } } : {}),
		}));
}

function mergePrimeInferenceModels(
	snapshotModels: Model<"openai-completions">[],
	catalogModels: Model<"openai-completions">[],
): Model<"openai-completions">[] {
	const models = new Map<string, Model<"openai-completions">>();
	for (const model of snapshotModels) {
		models.set(model.id.toLowerCase(), model);
	}
	for (const model of catalogModels) {
		models.set(model.id.toLowerCase(), model);
	}
	return Array.from(models.values());
}

function refreshPrimeInferenceAliasLimits(
	snapshotModels: Model<"openai-completions">[],
	catalogModels: Model<"openai-completions">[],
): Model<"openai-completions">[] {
	const liveModels = new Map(catalogModels.map((model) => [model.id.toLowerCase(), model]));
	return snapshotModels.map((model) => {
		const canonicalId = PRIME_INFERENCE_OPENROUTER_ALIASES[model.id.toLowerCase()];
		const canonical = canonicalId ? liveModels.get(canonicalId) : undefined;
		if (!canonical) {
			return model;
		}
		return {
			...model,
			contextWindow: canonical.contextWindow,
			maxTokens: canonical.maxTokens,
		};
	});
}

function getPrimeInferenceDisplayName(modelId: string): string {
	const rawName = modelId.split("/").at(-1) ?? modelId;
	return rawName
		.split(/[-_]+/)
		.filter((part) => part.length > 0)
		.map((part) => {
			if (part === part.toUpperCase() || /\d/.test(part)) return part.toUpperCase();
			if (part.length <= 3) return part.toUpperCase();
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}

function isPrimeInferenceReasoningModel(modelId: string, catalogReasoning?: boolean): boolean {
	if (catalogReasoning !== undefined) {
		return catalogReasoning;
	}

	const id = modelId.toLowerCase();
	return (
		id.includes("thinking") ||
		id.includes("deepseek-v4") ||
		id.startsWith("minimax/minimax-m") ||
		id.startsWith("moonshotai/kimi") ||
		id.startsWith("x-ai/grok-4") ||
		id.startsWith("z-ai/glm-") ||
		(id.startsWith("openai/gpt-5") && !id.includes("-chat")) ||
		/^anthropic\/claude-(?:fable-5|opus-4|sonnet-(?:4|5))/.test(id)
	);
}

function getPrimeInferenceCompat(modelId: string): OpenAICompletionsCompat {
	const id = modelId.toLowerCase();
	if (id.includes("deepseek-v4")) {
		return {
			...PRIME_INFERENCE_COMPAT,
			...DEEPSEEK_V4_COMPAT,
		};
	}
	if (id.startsWith("z-ai/glm-")) {
		return {
			...PRIME_INFERENCE_COMPAT,
			...ZAI_THINKING_COMPAT,
		};
	}

	return PRIME_INFERENCE_COMPAT;
}

interface PrimeInferenceOpenRouterMetadata {
	contextWindow?: number;
	maxTokens?: number;
	vision: boolean;
	reasoning: boolean;
	thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
	supportsReasoningEffort?: boolean;
}

function buildPrimeInferenceOpenRouterIndex(catalog: unknown[]): Map<string, PrimeInferenceOpenRouterMetadata> {
	const index = new Map<string, PrimeInferenceOpenRouterMetadata>();
	for (const item of catalog) {
		if (!isRecord(item) || typeof item.id !== "string") {
			continue;
		}
		const topProvider = isRecord(item.top_provider) ? item.top_provider : {};
		const architecture = isRecord(item.architecture) ? item.architecture : {};
		const modalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
		const supportedParameters = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
		const reasoningCapabilities = getOpenRouterReasoningCapabilities(item);
		index.set(item.id.toLowerCase(), {
			contextWindow: getOptionalNumber(item.context_length) ?? getOptionalNumber(topProvider.context_length),
			maxTokens: getOptionalNumber(topProvider.max_completion_tokens),
			vision: modalities.includes("image"),
			// Same signal the OpenRouter provider path uses; the top-level
			// `reasoning` object over-reports (e.g. qwen3-max carries one despite
			// not accepting reasoning params).
			reasoning: supportedParameters.includes("reasoning"),
			...(reasoningCapabilities?.thinkingLevelMap
				? { thinkingLevelMap: reasoningCapabilities.thinkingLevelMap }
				: {}),
			...(reasoningCapabilities
				? { supportsReasoningEffort: reasoningCapabilities.supportsReasoningEffort }
				: {}),
		});
	}
	return index;
}

function getPrimeInferenceOpenRouterMetadata(
	index: Map<string, PrimeInferenceOpenRouterMetadata>,
	modelId: string,
): PrimeInferenceOpenRouterMetadata | undefined {
	const id = modelId.toLowerCase();
	return index.get(PRIME_INFERENCE_OPENROUTER_ALIASES[id] ?? id);
}

async function fetchPrimeInferenceModels(): Promise<Model<"openai-completions">[]> {
	let catalog: PrimeInferenceCatalogEntry[] = [];

	try {
		console.log("Fetching public models from Prime Inference API...");
		const response = await fetch(`${PRIME_INFERENCE_BASE_URL}/models`);
		catalog = parsePrimeInferenceModelCatalog(await response.json());
	} catch (error) {
		console.error("Failed to fetch Prime Inference models:", error);
	}

	let openRouterIndex = new Map<string, PrimeInferenceOpenRouterMetadata>();
	try {
		openRouterIndex = buildPrimeInferenceOpenRouterIndex(await fetchOpenRouterCatalog());
	} catch (error) {
		console.error("Failed to fetch OpenRouter catalog for Prime Inference metadata:", error);
	}
	if (openRouterIndex.size === 0) {
		// Without OpenRouter metadata every model would regress to the defaults;
		// keep the previous snapshot instead.
		console.error("OpenRouter catalog unavailable; keeping snapshot Prime Inference models");
		return getExistingPrimeInferenceModels();
	}

	const catalogModels = catalog
		.filter((entry) => !isPrivatePrimeInferenceModelId(entry.id))
		.map((entry) =>
			createPrimeInferenceModel(
				entry,
				PRIME_INFERENCE_MODEL_METADATA[entry.id.toLowerCase()],
				getPrimeInferenceOpenRouterMetadata(openRouterIndex, entry.id),
			),
		);
	let snapshotModels = getExistingPrimeInferenceModels();
	if (catalog.length > 0 && catalogModels.length < Math.ceil(snapshotModels.length * 0.5)) {
		console.error("Prime Inference catalog is severely truncated; keeping snapshot models");
		return snapshotModels;
	}
	if (catalog.length > 0) {
		const liveIds = new Set(catalogModels.map((model) => model.id.toLowerCase()));
		snapshotModels = snapshotModels.filter((model) => liveIds.has(model.id.toLowerCase()));
	}
	snapshotModels = refreshPrimeInferenceAliasLimits(snapshotModels, catalogModels);
	const models = mergePrimeInferenceModels(snapshotModels, catalogModels);
	console.log(`Loaded ${models.length} Prime Inference models (${catalogModels.length} from the live catalog)`);
	return models;
}

function createPrimeInferenceModel(
	entry: PrimeInferenceCatalogEntry,
	override: PrimeInferenceModelMetadata | undefined,
	openRouter: PrimeInferenceOpenRouterMetadata | undefined,
): Model<"openai-completions"> {
	const vision = entry.vision ?? override?.vision ?? openRouter?.vision ?? false;
	const fallbackCacheCosts = getPrimeInferenceCacheCosts(entry.id, entry.input);
	const cacheCosts = {
		cacheRead: entry.cacheRead ?? fallbackCacheCosts.cacheRead,
		cacheWrite: entry.cacheWrite ?? fallbackCacheCosts.cacheWrite,
	};
	const contextWindow =
		entry.contextWindow ??
		override?.contextWindow ??
		openRouter?.contextWindow ??
		PRIME_INFERENCE_DEFAULT_CONTEXT_WINDOW;
	// Sources are independent, so an OpenRouter output cap can exceed a
	// gateway-measured window override; clamp to keep the pair coherent.
	const maxTokens = Math.min(
		entry.maxTokens ?? override?.maxTokens ?? openRouter?.maxTokens ?? PRIME_INFERENCE_DEFAULT_MAX_TOKENS,
		contextWindow,
	);
	const compat = getPrimeInferenceCompat(entry.id);
	return {
		id: entry.id,
		...(PRIME_INFERENCE_FEATURED_MODELS.has(entry.id.toLowerCase()) ? { featured: true } : {}),
		name: entry.name ?? override?.name ?? getPrimeInferenceDisplayName(entry.id),
		api: "openai-completions",
		provider: "prime-inference",
		baseUrl: PRIME_INFERENCE_BASE_URL,
		reasoning: isPrimeInferenceReasoningModel(entry.id, entry.reasoning ?? openRouter?.reasoning),
		...(openRouter?.thinkingLevelMap ? { thinkingLevelMap: openRouter.thinkingLevelMap } : {}),
		input: vision ? ["text", "image"] : ["text"],
		cost: {
			input: entry.input,
			output: entry.output,
			...cacheCosts,
		},
		contextWindow,
		maxTokens,
		compat: {
			...compat,
			...(openRouter?.supportsReasoningEffort !== undefined
				? {
						supportsReasoningEffort: openRouter.supportsReasoningEffort,
						...(!compat.thinkingFormat && openRouter.supportsReasoningEffort === false
							? { thinkingFormat: "openrouter" as const }
							: {}),
					}
				: {}),
		},
	};
}

let openRouterCatalogPromise: Promise<any[]> | undefined;

function fetchOpenRouterCatalog(): Promise<any[]> {
	openRouterCatalogPromise ??= (async () => {
		console.log("Fetching models from OpenRouter API...");
		const response = await fetch("https://openrouter.ai/api/v1/models");
		const data = await response.json();
		return Array.isArray(data?.data) ? data.data : [];
	})();
	return openRouterCatalogPromise;
}

async function fetchOpenRouterModels(): Promise<Model<any>[]> {
	try {
		const models: Model<any>[] = [];

		for (const model of await fetchOpenRouterCatalog()) {
			// Only include models that support tools
			if (!model.supported_parameters?.includes("tools")) continue;
			// :batch routes are asynchronous batch variants, not streaming models
			if (model.id.endsWith(":batch")) continue;

			// Parse provider from model ID
			let provider: KnownProvider = "openrouter";
			let modelKey = model.id;

			modelKey = model.id; // Keep full ID for OpenRouter

			// Parse input modalities
			const input: ("text" | "image")[] = ["text"];
			if (model.architecture?.modality?.includes("image")) {
				input.push("image");
			}

			// Convert pricing from $/token to $/million tokens. OpenRouter uses
			// negative values as a placeholder for unknown pricing (e.g. auto-beta).
			// Time-windowed tariff overrides (utc_start/utc_end) make the top-level
			// price clock-dependent (e.g. Tencent Hy3 peak/off-peak); commit the peak
			// rate so cost accounting never undercounts and regens stay hour-independent.
			const timeWindowedTariffs = (Array.isArray(model.pricing?.overrides) ? model.pricing.overrides : []).filter(
				(override: any) => typeof override?.utc_start === "number",
			);
			const peakPrice = (field: string): number =>
				Math.max(
					0,
					parseFloat(model.pricing?.[field] || "0"),
					...timeWindowedTariffs.map((override: any) => parseFloat(override?.[field] || "0")),
				) * 1_000_000;
			const inputCost = peakPrice("prompt");
			const outputCost = peakPrice("completion");
			const cacheReadCost = peakPrice("input_cache_read");
			const cacheWriteCost = peakPrice("input_cache_write");
			const reasoningCapabilities = getOpenRouterReasoningCapabilities(model);

			const normalizedModel: Model<any> = {
				id: modelKey,
				name: model.name,
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
				provider,
				reasoning: model.supported_parameters?.includes("reasoning") || false,
				...(reasoningCapabilities?.thinkingLevelMap
					? { thinkingLevelMap: reasoningCapabilities.thinkingLevelMap }
					: {}),
				...(reasoningCapabilities
					? { compat: { supportsReasoningEffort: reasoningCapabilities.supportsReasoningEffort } }
					: {}),
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow: model.context_length || 4096,
				maxTokens: model.top_provider?.max_completion_tokens || 4096,
			};
			models.push(normalizedModel);
		}

		console.log(`Fetched ${models.length} tool-capable models from OpenRouter`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenRouter models:", error);
		return [];
	}
}

async function fetchAiGatewayModels(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from Vercel AI Gateway API...");
		const response = await fetch(`${AI_GATEWAY_MODELS_URL}/models`);
		const data = await response.json();
		const models: Model<any>[] = [];

		const toNumber = (value: string | number | undefined): number => {
			if (typeof value === "number") {
				return Number.isFinite(value) ? value : 0;
			}
			const parsed = parseFloat(value ?? "0");
			return Number.isFinite(parsed) ? parsed : 0;
		};

		const items = Array.isArray(data.data) ? (data.data as AiGatewayModel[]) : [];
		for (const model of items) {
			const tags = Array.isArray(model.tags) ? model.tags : [];
			// Only include models that support tools
			if (!tags.includes("tool-use")) continue;

			const input: ("text" | "image")[] = ["text"];
			if (tags.includes("vision")) {
				input.push("image");
			}

			const inputCost = toNumber(model.pricing?.input) * 1_000_000;
			const outputCost = toNumber(model.pricing?.output) * 1_000_000;
			const cacheReadCost = toNumber(model.pricing?.input_cache_read) * 1_000_000;
			const cacheWriteCost = toNumber(model.pricing?.input_cache_write) * 1_000_000;

			let thinkingLevelMap: ThinkingLevelMap | undefined;
			if (Array.isArray(model.reasoning_options)) {
				const effortOption = model.reasoning_options.find((opt) => opt.type === "effort");
				const toggleOption = model.reasoning_options.find((opt) => opt.type === "toggle");
				if (effortOption && Array.isArray(effortOption.values) && effortOption.values.length > 0) {
					const values = effortOption.values;
					const hasNone = values.includes("none") || values.includes("off");
					const canTurnOff = hasNone || toggleOption !== undefined;
					thinkingLevelMap = {
						off: canTurnOff ? "none" : null,
						minimal: values.includes("minimal") ? "minimal" : null,
						low: values.includes("low") ? "low" : null,
						medium: values.includes("medium") ? "medium" : null,
						high: values.includes("high") ? "high" : null,
						xhigh: values.includes("xhigh") ? "xhigh" : null,
						max: values.includes("max") ? "max" : null,
					};
				}
			}

			models.push({
				id: model.id,
				name: model.name || model.id,
				api: "anthropic-messages",
				baseUrl: AI_GATEWAY_BASE_URL,
				provider: "vercel-ai-gateway",
				// DeepSeek's *-thinking routes always think; the gateway omits the tag.
				reasoning: tags.includes("reasoning") || model.id.includes("-thinking") || thinkingLevelMap !== undefined,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow: model.context_window || 4096,
				maxTokens: model.max_tokens || 4096,
			});
		}

		console.log(`Fetched ${models.length} tool-capable models from Vercel AI Gateway`);
		return models;
	} catch (error) {
		console.error("Failed to fetch Vercel AI Gateway models:", error);
		return [];
	}
}

async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		const data = await response.json();

		const models: Model<any>[] = [];

		// Process Amazon Bedrock models
		if (data["amazon-bedrock"]?.models) {
			for (const [modelId, model] of Object.entries(data["amazon-bedrock"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				let id = modelId;

				if (id.startsWith("ai21.jamba")) {
					// These models doesn't support tool use in streaming mode
					continue;
				}

				if (id.startsWith("mistral.mistral-7b-instruct-v0")) {
					// These models doesn't support system messages
					continue;
				}

				models.push({
					id,
					name: m.name || id,
					api: "bedrock-converse-stream" as const,
					provider: "amazon-bedrock" as const,
					baseUrl: getBedrockBaseUrl(id),
					reasoning: m.reasoning === true,
					input: (m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Anthropic models
		if (data.anthropic?.models) {
			for (const [modelId, model] of Object.entries(data.anthropic.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Google models. Live API models (bidirectional streaming sessions), Deep
		// Research models (Interactions API), and Computer Use models (require the
		// computer_use tool) are not usable through the GenerateContent API as plain
		// chat models, so they are excluded.
		const googleUnsupportedApiModelPattern = /(^|[-_.])(live|deep-research|computer-use)($|[-_.])/i;
		if (data.google?.models) {
			for (const [modelId, model] of Object.entries(data.google.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (googleUnsupportedApiModelPattern.test(modelId)) continue;
				// Image-generation variants return inlineData parts the provider drops.
				if (m.modalities?.output?.includes("image")) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "google-generative-ai",
					provider: "google",
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process OpenAI models
		if (data.openai?.models) {
			for (const [modelId, model] of Object.entries(data.openai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Groq models
		if (data.groq?.models) {
			for (const [modelId, model] of Object.entries(data.groq.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "groq",
					baseUrl: "https://api.groq.com/openai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Cerebras models
		if (data.cerebras?.models) {
			for (const [modelId, model] of Object.entries(data.cerebras.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cerebras",
					baseUrl: "https://api.cerebras.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Cloudflare Workers AI models
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const hasDeepseekReasoning =
					modelId.toLowerCase().includes("deepseek") &&
					(m.interleaved?.field === "reasoning_content" || modelId.toLowerCase().includes("deepseek-v4"));
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cloudflare-workers-ai",
					baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: {
						sendSessionAffinityHeaders: true,
						...(hasDeepseekReasoning
							? {
									requiresReasoningContentOnAssistantMessages: true,
									thinkingFormat: "deepseek",
								}
							: {}),
					},
				});
			}
		}

		// Process Cloudflare AI Gateway models
		if (data["cloudflare-ai-gateway"]?.models) {
			for (const [prefixedId, model] of Object.entries(data["cloudflare-ai-gateway"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const slashIdx = prefixedId.indexOf("/");
				if (slashIdx === -1) continue;
				const upstream = prefixedId.slice(0, slashIdx);
				const nativeId = prefixedId.slice(slashIdx + 1);

				let api: "anthropic-messages" | "openai-completions" | "openai-responses";
				let baseUrl: string;
				let id: string;
				if (upstream === "openai") {
					api = "openai-responses";
					baseUrl = CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL;
					id = nativeId;
				} else if (upstream === "anthropic") {
					api = "anthropic-messages";
					baseUrl = CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL;
					id = nativeId;
				} else if (upstream === "workers-ai") {
					api = "openai-completions";
					baseUrl = CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL;
					id = prefixedId;
				} else {
					continue;
				}

				// workers-ai/* through the gateway forwards x-session-affinity to
				// the underlying Workers AI runtime for prefix-cache routing.
				const compat = upstream === "workers-ai" ? { sendSessionAffinityHeaders: true } : undefined;

				models.push({
					id,
					name: m.name || id,
					api,
					provider: "cloudflare-ai-gateway",
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(compat ? { compat } : {}),
				});
			}
		}

		// Process xAi models
		if (data.xai?.models) {
			for (const [modelId, model] of Object.entries(data.xai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "xai",
					baseUrl: "https://api.x.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process zAi models
		if (data["zai-coding-plan"]?.models) {
			for (const [modelId, model] of Object.entries(data["zai-coding-plan"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				const supportsImage = m.modalities?.input?.includes("image");

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "zai",
					baseUrl: "https://api.z.ai/api/coding/paas/v4",
					reasoning: m.reasoning === true,
					input: supportsImage ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: {
						supportsDeveloperRole: false,
						supportsReasoningEffort: modelId.startsWith("glm-5.2"),
						thinkingFormat: ZAI_THINKING_COMPAT.thinkingFormat,
						...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(modelId) ? { zaiToolStream: true } : {}),
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Mistral models
		if (data.mistral?.models) {
			for (const [modelId, model] of Object.entries(data.mistral.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "mistral-conversations",
					provider: "mistral",
					baseUrl: "https://api.mistral.ai",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Hugging Face models
		if (data.huggingface?.models) {
			for (const [modelId, model] of Object.entries(data.huggingface.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "huggingface",
					baseUrl: "https://router.huggingface.co/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: {
						supportsDeveloperRole: false,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process OrcaRouter models
		if (data.orcarouter?.models) {
			for (const [modelId, model] of Object.entries(data.orcarouter.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// skip image/video generation-only outputs
				if (m.modalities?.output?.includes("image") || m.modalities?.output?.includes("video")) continue;
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "orcarouter",
					baseUrl: "https://api.orcarouter.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(modelId === "orcarouter/auto" ? { featured: true } : {}),
				});
			}
		}

		// Process Fireworks models
		if (data["fireworks-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["fireworks-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "fireworks",
					// Fireworks Anthropic-compatible API - SDK appends /v1/messages
					baseUrl: "https://api.fireworks.ai/inference",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process OpenCode models (Zen and Go)
		// API mapping based on provider.npm field:
		// - @ai-sdk/openai → openai-responses
		// - @ai-sdk/anthropic → anthropic-messages
		// - @ai-sdk/google → google-generative-ai
		// - null/undefined/@ai-sdk/openai-compatible → openai-completions
		const opencodeVariants = [
			{ key: "opencode", provider: "opencode", basePath: "https://opencode.ai/zen" },
			{ key: "opencode-go", provider: "opencode-go", basePath: "https://opencode.ai/zen/go" },
		] as const;

		for (const variant of opencodeVariants) {
			if (!data[variant.key]?.models) continue;

			for (const [modelId, model] of Object.entries(data[variant.key].models)) {
				const m = model as ModelsDevModel & { status?: string };
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const npm = m.provider?.npm;
				let api: Api;
				let baseUrl: string;
				let compat: OpenAICompletionsCompat | undefined;

				if (npm === "@ai-sdk/openai") {
					api = "openai-responses";
					baseUrl = `${variant.basePath}/v1`;
				} else if (npm === "@ai-sdk/anthropic") {
					api = "anthropic-messages";
					// Anthropic SDK appends /v1/messages to baseURL
					baseUrl = variant.basePath;
				} else if (npm === "@ai-sdk/google") {
					api = "google-generative-ai";
					baseUrl = `${variant.basePath}/v1`;
				} else if (npm === "@ai-sdk/alibaba") {
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
					compat = { cacheControlFormat: "anthropic" };
				} else {
					// null, undefined, or @ai-sdk/openai-compatible
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
				}

				// Fix known mismatches between models.dev npm data and actual
				// OpenCode Go endpoint behaviour. models.dev reports these models
				// as @ai-sdk/anthropic, but the OpenCode Go endpoints either don't
				// accept Anthropic SDK auth (MiniMax M2.7) or are served through
				// the OpenAI-compatible /v1/chat/completions path (Qwen routes).
				// Switch them to openai-completions so requests use Bearer auth
				// and the standard /v1/chat/completions endpoint.
				if (variant.provider === "opencode-go") {
					if (modelId === "minimax-m2.7" || (npm === "@ai-sdk/anthropic" && modelId.startsWith("qwen"))) {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
					}
					if (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
						// Qwen/DashScope uses enable_thinking at the top level.
						compat = { ...(compat ?? {}), thinkingFormat: "qwen" };
					}
				}

				if (api === "openai-completions" && modelId.toLowerCase().includes("deepseek")) {
					if (m.interleaved?.field === "reasoning_content" || modelId.toLowerCase().includes("deepseek-v4")) {
						compat = {
							...(compat ?? {}),
							requiresReasoningContentOnAssistantMessages: true,
							thinkingFormat: "deepseek",
							...(!modelId.toLowerCase().includes("deepseek-v4") ? { supportsReasoningEffort: false } : {}),
						};
					}
				}

				models.push({
					id: modelId,
					name: m.name || modelId,
					api,
					provider: variant.provider,
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					...(compat ? { compat } : {}),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process GitHub Copilot models
		if (data["github-copilot"]?.models) {
			for (const [modelId, model] of Object.entries(data["github-copilot"].models)) {
				const m = model as ModelsDevModel & { status?: string };
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				// Copilot proxies Claude via the Anthropic Messages API
				const isCopilotClaude = modelId.startsWith("claude-");
				// gpt-5/gpt-6 models require responses API, others use completions
				const needsResponsesApi =
					modelId.startsWith("gpt-5") || modelId.startsWith("gpt-6") || modelId.startsWith("oswe");

				const api: Api = isCopilotClaude
					? "anthropic-messages"
					: needsResponsesApi
						? "openai-responses"
						: "openai-completions";

				const anthropicCompat =
					api === "anthropic-messages" ? getAnthropicMessagesCompat("github-copilot", modelId) : undefined;

				const copilotModel: Model<any> = {
					id: modelId,
					name: m.name || modelId,
					api,
					provider: "github-copilot",
					baseUrl: "https://api.individual.githubcopilot.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 128000,
					maxTokens: m.limit?.output || 8192,
					headers: { ...COPILOT_STATIC_HEADERS },
					...(anthropicCompat ? { compat: anthropicCompat } : {}),
					// compat only applies to openai-completions
					...(api === "openai-completions" ? {
						compat: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
					} : {}),
				};

				models.push(copilotModel);
			}
		}

		// Process MiniMax models
		const minimaxVariants = [
			{ key: "minimax", provider: "minimax", baseUrl: "https://api.minimax.io/anthropic" },
			{ key: "minimax-cn", provider: "minimax-cn", baseUrl: "https://api.minimaxi.com/anthropic" },
		] as const;

		for (const { key, provider, baseUrl } of minimaxVariants) {
			if (data[key]?.models) {
				for (const [modelId, model] of Object.entries(data[key].models)) {
					const m = model as ModelsDevModel;
					if (m.tool_call !== true) continue;

					models.push({
						id: modelId,
						name: m.name || modelId,
						api: "anthropic-messages",
						provider,
						// MiniMax's Anthropic-compatible API - SDK appends /v1/messages
						baseUrl,
						reasoning: m.reasoning === true,
						input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
					});
				}
			}
		}

		// Process Kimi For Coding models
		if (data["kimi-for-coding"]?.models) {
			const kimiModels = data["kimi-for-coding"].models as Record<string, ModelsDevModel>;
			const hasCanonicalModel = Object.prototype.hasOwnProperty.call(kimiModels, "kimi-for-coding");

			const kimiAliases = new Set(["k2p5", "k2p6"]);

			for (const [modelId, model] of Object.entries(kimiModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// models.dev may expose versioned aliases (e.g. k2p5/k2p6).
				// Normalize aliases to the canonical model id and drop duplicates when canonical exists.
				if (kimiAliases.has(modelId) && hasCanonicalModel) continue;

				const normalizedId = kimiAliases.has(modelId) ? "kimi-for-coding" : modelId;
				const normalizedName = kimiAliases.has(modelId) ? "Kimi For Coding" : m.name || normalizedId;

				models.push({
					id: normalizedId,
					name: normalizedName,
					api: "anthropic-messages",
					provider: "kimi-coding",
					// Kimi For Coding's Anthropic-compatible API - SDK appends /v1/messages
					baseUrl: "https://api.kimi.com/coding",
					headers: { ...KIMI_STATIC_HEADERS },
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Moonshot AI models
		const moonshotVariants = [
			{ key: "moonshotai", provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" },
			{ key: "moonshotai-cn", provider: "moonshotai-cn", baseUrl: "https://api.moonshot.cn/v1" },
		] as const;
		const moonshotCompat: OpenAICompletionsCompat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		};

		for (const { key, provider, baseUrl } of moonshotVariants) {
			if (!data[key]?.models) continue;

			for (const [modelId, model] of Object.entries(data[key].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: moonshotCompat,
				});
			}
		}

		// Process Xiaomi MiMo models
		// Built-in `xiaomi` targets the API billing endpoint (single stable URL,
		// keys from platform.xiaomimimo.com). The three `xiaomi-token-plan-*`
		// providers cover prepaid Token Plan endpoints in cn / ams / sgp.
		const xiaomiVariants = [
			{ provider: "xiaomi", baseUrl: "https://api.xiaomimimo.com/anthropic" },
			{ provider: "xiaomi-token-plan-cn", baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic" },
			{ provider: "xiaomi-token-plan-ams", baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic" },
			{ provider: "xiaomi-token-plan-sgp", baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic" },
		] as const;

		if (data.xiaomi?.models) {
			for (const { provider, baseUrl } of xiaomiVariants) {
				for (const [modelId, model] of Object.entries(data.xiaomi.models)) {
					const m = model as ModelsDevModel;
					if (m.tool_call !== true) continue;

					models.push({
						id: modelId,
						name: m.name || modelId,
						api: "anthropic-messages",
						provider,
						baseUrl,
						reasoning: m.reasoning === true,
						input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
					});
				}
			}
		}

		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		return [];
	}
}

function getExistingCatalogModels(): Model<any>[] {
	const providers = EXISTING_MODELS as unknown as Record<string, Record<string, Model<any>>>;
	return Object.values(providers).flatMap((models) =>
		Object.values(models).map((model) => ({
			...model,
			input: [...model.input],
			cost: { ...model.cost },
			...(model.headers ? { headers: { ...model.headers } } : {}),
			...(model.compat ? { compat: { ...model.compat } } : {}),
			...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
			...(model.reasoningCapabilities
				? {
						reasoningCapabilities: {
							control: model.reasoningCapabilities.control,
							levels: { ...model.reasoningCapabilities.levels },
							...(model.reasoningCapabilities.control === "budget" &&
							model.reasoningCapabilities.supportsOff
								? { supportsOff: true }
								: {}),
						},
					}
				: {}),
		})),
	);
}

function updatePreservedReasoningMetadata(model: Model<any>): void {
	if (!model.reasoning) {
		delete model.thinkingLevelMap;
		delete model.reasoningCapabilities;
		return;
	}
	if (applyProviderSpecificReasoningMetadata(model)) return;
	if (
		model.api === "openai-completions" &&
		model.provider === "cloudflare-workers-ai" &&
		model.id.toLowerCase().includes("deepseek")
	) {
		model.compat = {
			...model.compat,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		};
	}
	if (
		model.provider === "github-copilot" &&
		!GITHUB_COPILOT_CONFIGURABLE_REASONING_MODELS.has(model.id.toLowerCase())
	) {
		model.thinkingLevelMap = { ...FIXED_REASONING_LEVEL_MAP };
		model.reasoningCapabilities = { control: "fixed", levels: { ...FIXED_REASONING_LEVEL_MAP } };
		return;
	}
	if (
		isNativeAnthropicClaudeRoute(model) &&
		(model.provider === "cloudflare-ai-gateway" || model.provider === "vercel-ai-gateway")
	) {
		delete model.thinkingLevelMap;
		delete model.reasoningCapabilities;
		applyThinkingLevelMetadata(model);
		return;
	}
	if (
		model.api === "openai-completions" &&
		(model.provider === "opencode" || model.provider === "opencode-go") &&
		model.id.toLowerCase().includes("deepseek")
	) {
		model.compat = {
			...model.compat,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
			...(!model.id.toLowerCase().includes("deepseek-v4") ? { supportsReasoningEffort: false } : {}),
		};
		model.thinkingLevelMap = { ...FIXED_REASONING_LEVEL_MAP };
		model.reasoningCapabilities = { control: "fixed", levels: { ...FIXED_REASONING_LEVEL_MAP } };
		return;
	}
	if (isOpenRouterDeepSeekV4Route(model)) {
		refreshPreservedOpenRouterDeepSeekV4Reasoning(model);
	}
	if (isPrimeDeepSeekV4Route(model)) {
		refreshPrimeDeepSeekV4Reasoning(model);
	}
	if (isPrimeGpt56Route(model)) {
		const levels = getOpenAiReasoningLevelMap(model.id);
		if (levels) {
			model.thinkingLevelMap = { ...levels };
			model.reasoningCapabilities = { control: "effort", levels: { ...levels } };
			model.compat = {
				...model.compat,
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
			};
		}
	}
	if (
		model.id.includes("muse-spark-1.3") ||
		model.id.includes("muse-spark-1.3-contributor")
	) {
		const parsedLevels = model.thinkingLevelMap ?? {};
		const museSparkLevels = {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			...parsedLevels,
			max: null,
		};
		model.thinkingLevelMap = { ...museSparkLevels };
		model.reasoningCapabilities = { control: "effort", levels: { ...museSparkLevels } };
		if (model.compat) {
			model.compat.supportsReasoningEffort = true;
		}
	}
	const kimiK3Id = model.id.toLowerCase();
	if (
		model.api === "openai-completions" &&
		model.compat?.supportsReasoningEffort === true &&
		(/^k3(-|$)/.test(kimiK3Id) || /(^|\/)kimi-k3(-|$)/.test(kimiK3Id))
	) {
		mergeThinkingLevelMap(model, { off: "none" });
		if (model.reasoningCapabilities) {
			model.reasoningCapabilities = {
				...model.reasoningCapabilities,
				levels: { ...model.reasoningCapabilities.levels, off: "none" },
			};
		}
	}

	if (!model.reasoningCapabilities) {
		applyThinkingLevelMetadata(model);
	}
	if (!model.reasoningCapabilities) {
		return;
	}
	if (model.api === "openai-responses" && model.provider === "github-copilot") {
		replaceReasoningOffValue(model, null);
	}
	if (isGoogleThinkingApi(model) && isGemini3ProModel(model.id)) {
		model.reasoningCapabilities = {
			...model.reasoningCapabilities,
			levels: {
				...model.reasoningCapabilities.levels,
				medium: supportsGemini3ProMedium(model.id) ? "MEDIUM" : null,
			},
		};
		syncLegacyThinkingLevelMap(model);
	}
	const geminiFlashThinkingLevelMap = getGeminiFlashThinkingLevelMap(model.id);
	if (isGoogleThinkingApi(model) && geminiFlashThinkingLevelMap) {
		model.reasoningCapabilities = { control: "effort", levels: { ...geminiFlashThinkingLevelMap } };
		model.thinkingLevelMap = { ...geminiFlashThinkingLevelMap };
	}
	const googleBudgetLevels = isGoogleThinkingApi(model) ? getGoogleBudgetLevelMap(model.id) : undefined;
	if (googleBudgetLevels) {
		model.reasoningCapabilities = {
			control: "budget",
			levels: { ...googleBudgetLevels },
		};
		syncLegacyThinkingLevelMap(model);
	} else if (isGoogleThinkingApi(model) && hasNumericReasoningLevels(model.reasoningCapabilities.levels)) {
		model.reasoningCapabilities = {
			control: "budget",
			levels: { ...model.reasoningCapabilities.levels },
		};
		syncLegacyThinkingLevelMap(model);
	}
	const preservedClaudeBudget =
		model.reasoningCapabilities.control === "budget" &&
		(isNativeAnthropicClaudeRoute(model) ||
			(model.api === "bedrock-converse-stream" &&
				(model.id.toLowerCase().includes("claude") || model.name.toLowerCase().includes("claude"))));
	if (preservedClaudeBudget) {
		const { off: _legacyOff, ...levels } = model.reasoningCapabilities.levels;
		model.reasoningCapabilities = {
			control: "budget",
			levels: levels as ReasoningBudgetLevelMap,
			supportsOff: true,
		};
		syncLegacyThinkingLevelMap(model);
	}
	if (model.api === "openai-completions" && model.provider === "openrouter") {
		model.compat = {
			...model.compat,
			supportsReasoningEffort: model.reasoningCapabilities.control === "effort",
		};
		if (model.reasoningCapabilities.levels.off === "off") {
			replaceReasoningOffValue(model, "none");
		}
	}
	if (model.api === "openai-completions" && model.provider === "orcarouter" && model.reasoning) {
		// OrcaRouter translates flat reasoning_effort across upstreams.
		model.compat = {
			...model.compat,
			supportsReasoningEffort: true,
		};
		model.reasoningCapabilities = {
			control: "effort",
			levels: {
				off: "none",
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: null,
				max: null,
			},
		};
		syncLegacyThinkingLevelMap(model);
	}
	if (
		model.api === "openai-completions" &&
		model.provider === "prime-inference" &&
		model.reasoningCapabilities.levels.off === "off" &&
		model.compat?.thinkingFormat !== "zai" &&
		model.compat?.thinkingFormat !== "deepseek" &&
		model.compat?.thinkingFormat !== "qwen" &&
		model.compat?.thinkingFormat !== "qwen-chat-template"
	) {
		replaceReasoningOffValue(model, "none");
	}
	if (model.api === "mistral-conversations" && isMistralReasoningEffortModel(model.id)) {
		model.reasoningCapabilities = {
			control: "effort",
			levels: {
				...model.reasoningCapabilities.levels,
				off: "none",
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			},
		};
		syncLegacyThinkingLevelMap(model);
		return;
	}

	const namedEffort =
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses";
	if (!model.reasoning || !namedEffort) return;

	const documentedLevels = getOpenAiReasoningLevelMap(model.id);
	const documentedOff = documentedLevels?.off;
	const off =
		model.provider === "github-copilot"
			? null
			: documentedOff !== undefined
			? documentedOff
			: model.reasoningCapabilities.levels.off === "none"
				? "none"
				: null;
	const supportsMinimal = /(?:^|\/)gpt-5-(?:mini|nano)(?:-|$)/.test(model.id.toLowerCase());
	model.reasoningCapabilities = {
		control: "effort",
		levels: {
			...model.reasoningCapabilities.levels,
			...(supportsMinimal ? { minimal: "minimal" } : {}),
			off,
		},
	};
	syncLegacyThinkingLevelMap(model);
}

const GROK_CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/**
 * xAI Grok subscription models served through the Grok CLI chat proxy.
 * These mirror the xAI API catalog but are billed against a SuperGrok /
 * X Premium+ subscription via OAuth instead of api.x.ai credits.
 */
function getGrokSubscriptionModels(): Model<"grok-responses">[] {
	const models: Model<"grok-responses">[] = [
		{
			id: "grok-4.6",
			name: "Grok 4.6",
			api: "grok-responses",
			provider: "grok",
			baseUrl: GROK_CLI_PROXY_BASE_URL,
			reasoning: true,
			reasoningCapabilities: {
				control: "effort",
				levels: { off: null, high: "high", minimal: null, low: "low", medium: "medium", xhigh: "xhigh", max: null },
			},
			input: ["text", "image"],
			cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 500000,
			maxTokens: 500000,
		},
		{
			id: "grok-4.5",
			name: "Grok 4.5",
			api: "grok-responses",
			provider: "grok",
			baseUrl: GROK_CLI_PROXY_BASE_URL,
			reasoning: true,
			reasoningCapabilities: {
				control: "effort",
				levels: { off: null, high: "high", minimal: null, low: "low", medium: "medium", xhigh: null, max: null },
			},
			input: ["text", "image"],
			cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
			contextWindow: 500000,
			maxTokens: 500000,
		},
		{
			id: "grok-4.3",
			name: "Grok 4.3",
			api: "grok-responses",
			provider: "grok",
			baseUrl: GROK_CLI_PROXY_BASE_URL,
			reasoning: true,
			reasoningCapabilities: { control: "fixed", levels: { off: null, high: "always" } },
			input: ["text", "image"],
			cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 30000,
		},
		{
			id: "grok-4.20-0309-reasoning",
			name: "Grok 4.20 (Reasoning)",
			api: "grok-responses",
			provider: "grok",
			baseUrl: GROK_CLI_PROXY_BASE_URL,
			reasoning: true,
			reasoningCapabilities: { control: "fixed", levels: { off: null, high: "always" } },
			input: ["text", "image"],
			cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 30000,
		},
		{
			id: "grok-4.20-0309-non-reasoning",
			name: "Grok 4.20 (Non-Reasoning)",
			api: "grok-responses",
			provider: "grok",
			baseUrl: GROK_CLI_PROXY_BASE_URL,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 30000,
		},
		{
			id: "grok-build-0.1",
			name: "Grok Build 0.1",
			api: "grok-responses",
			provider: "grok",
			baseUrl: GROK_CLI_PROXY_BASE_URL,
			reasoning: true,
			reasoningCapabilities: { control: "fixed", levels: { off: null, high: "always" } },
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 256000,
			maxTokens: 256000,
		},
		{
			id: "grok-code-fast-1",
			name: "Grok Code Fast 1",
			api: "grok-responses",
			provider: "grok",
			baseUrl: GROK_CLI_PROXY_BASE_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 0.2, output: 1.5, cacheRead: 0.02, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 8192,
		},
	];
	return models;
}

const AUDN_BASE_URL = "https://platform.audn.ai/api/v1";
const AUDN_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: true,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
};
const AUDN_REASONING_COMPAT: OpenAICompletionsCompat = {
	...AUDN_COMPAT,
	requiresReasoningContentOnAssistantMessages: true,
};

/**
 * audn.ai OpenAI-compatible catalog. Not on models.dev; sourced from
 * https://platform.audn.ai/docs. Reasoning models always think server-side and
 * return `reasoning_content`; there is no client reasoning-effort control.
 */
function getAudnModels(): Model<"openai-completions">[] {
	return [
		{
			id: "pingu-unchained-10",
			name: "Pingu Unchained 10",
			api: "openai-completions",
			provider: "audn",
			baseUrl: AUDN_BASE_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 16384,
			compat: { ...AUDN_COMPAT },
		},
		{
			id: "kong",
			name: "Kong",
			api: "openai-completions",
			provider: "audn",
			baseUrl: AUDN_BASE_URL,
			reasoning: true,
			reasoningCapabilities: { control: "fixed", levels: { ...FIXED_REASONING_LEVEL_MAP } },
			input: ["text"],
			cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 8192,
			compat: { ...AUDN_REASONING_COMPAT },
		},
		{
			id: "godzilla",
			name: "GODZILLA",
			api: "openai-completions",
			provider: "audn",
			baseUrl: AUDN_BASE_URL,
			reasoning: true,
			reasoningCapabilities: { control: "fixed", levels: { ...FIXED_REASONING_LEVEL_MAP } },
			input: ["text"],
			cost: { input: 7, output: 18, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 8192,
			compat: { ...AUDN_REASONING_COMPAT },
		},
		{
			id: "necromicon",
			name: "Necromicon",
			api: "openai-completions",
			provider: "audn",
			baseUrl: AUDN_BASE_URL,
			reasoning: true,
			reasoningCapabilities: { control: "effort", levels: { ...MOONSHOT_K3_EFFORT_LEVEL_MAP } },
			input: ["text"],
			cost: { input: 4, output: 21, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 8192,
			featured: true,
			compat: {
				...AUDN_REASONING_COMPAT,
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
			},
		},
		{
			id: "stealth-ox-alpha",
			name: "Stealth Ox Alpha",
			api: "openai-completions",
			provider: "audn",
			baseUrl: AUDN_BASE_URL,
			reasoning: true,
			reasoningCapabilities: { control: "fixed", levels: { ...FIXED_REASONING_LEVEL_MAP } },
			input: ["text"],
			cost: { input: 4, output: 21, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 8192,
			compat: { ...AUDN_REASONING_COMPAT },
		},
		{
			id: "k3-thinker-qwen38",
			name: "K3-Thinker-Qwen38",
			api: "openai-completions",
			provider: "audn",
			baseUrl: AUDN_BASE_URL,
			reasoning: true,
			reasoningCapabilities: { control: "effort", levels: { ...MOONSHOT_K3_EFFORT_LEVEL_MAP } },
			input: ["text"],
			cost: { input: 4, output: 21, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 8192,
			compat: {
				...AUDN_REASONING_COMPAT,
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
			},
		},
		{
			id: "bartzabel",
			name: "Bartzabel",
			api: "openai-completions",
			provider: "audn",
			baseUrl: AUDN_BASE_URL,
			reasoning: true,
			reasoningCapabilities: { control: "fixed", levels: { ...FIXED_REASONING_LEVEL_MAP } },
			input: ["text"],
			cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 8192,
			featured: true,
			compat: { ...AUDN_REASONING_COMPAT },
		},
	];
}

function getAbliterationModels(): Model<"openai-responses">[] {
	const baseUrl = "https://api.abliteration.ai/v1";
	return [
		{
			id: "abliterated-model",
			name: "Abliterated Model",
			api: "openai-responses",
			provider: "abliteration",
			baseUrl,
			reasoning: true,
			reasoningCapabilities: {
				control: "effort",
				levels: {
					off: "none",
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: null,
				},
			},
			input: ["text", "image"],
			cost: { input: 3, output: 3, cacheRead: 0.3, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 262134,
		},
		{
			id: "abliterated-model-large-v2",
			name: "Abliterated Model Large V2",
			api: "openai-responses",
			provider: "abliteration",
			baseUrl,
			reasoning: true,
			reasoningCapabilities: {
				control: "effort",
				levels: {
					off: "none",
					minimal: "low",
					low: "low",
					medium: "high",
					high: "high",
					xhigh: "max",
					max: "max",
				},
			},
			input: ["text"],
			cost: { input: 5, output: 5, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 999990,
			featured: true,
		},
		{
			id: "abliterated-model-large",
			name: "Abliterated Model Large",
			api: "openai-responses",
			provider: "abliteration",
			baseUrl,
			reasoning: true,
			reasoningCapabilities: {
				control: "effort",
				levels: {
					off: "none",
					minimal: "high",
					low: "high",
					medium: "high",
					high: "high",
					xhigh: "max",
					max: "max",
				},
			},
			input: ["text"],
			cost: { input: 5, output: 5, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 999990,
		},
	];
}

function getOrcaRouterAutoModel(): Model<"openai-completions"> {
	return {
		id: "orcarouter/auto",
		name: "OrcaRouter Auto",
		featured: true,
		api: "openai-completions",
		provider: "orcarouter",
		baseUrl: "https://api.orcarouter.ai/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function mergeCatalogModels(allModels: Model<any>[], extra: Model<any>[]): void {
	for (const model of extra) {
		if (!allModels.some((existing) => existing.provider === model.provider && existing.id === model.id)) {
			allModels.push(model);
		}
	}
}

function mergeStaticCatalogModels(allModels: Model<any>[]): void {
	mergeCatalogModels(allModels, [
		...getGrokSubscriptionModels(),
		...getAudnModels(),
		...getAbliterationModels(),
		getOrcaRouterAutoModel(),
	]);
}

async function generateModels() {
	if (process.argv.includes("--preserve-catalog")) {
		const preservedModels = getExistingCatalogModels();
		mergeStaticCatalogModels(preservedModels);
		writeGeneratedModels(preservedModels, true);
		return;
	}

	// Fetch models from both sources
	// models.dev: Anthropic, Google, OpenAI, Groq, Cerebras
	// OpenRouter: xAI and other providers (excluding Anthropic, Google, OpenAI)
	// AI Gateway: OpenAI-compatible catalog with tool-capable models
	const modelsDevModels = await loadModelsDevData();
	const openRouterModels = await fetchOpenRouterModels();
	const aiGatewayModels = await fetchAiGatewayModels();

	// Combine models (models.dev has priority)
	const allModels = [...modelsDevModels, ...openRouterModels, ...aiGatewayModels].filter(
		(model) =>
			!((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "gpt-5.3-codex-spark") &&
			!model.id.toLowerCase().includes("gemini-robotics-er-1.6"),
	);

	// Fix incorrect cache pricing for Claude Opus 4.5 from models.dev
	// models.dev has 3x the correct pricing (1.5/18.75 instead of 0.5/6.25)
	const opus45 = allModels.find(m => m.provider === "anthropic" && m.id === "claude-opus-4-5");
	if (opus45) {
		opus45.cost.cacheRead = 0.5;
		opus45.cost.cacheWrite = 6.25;
	}

	// Temporary overrides until upstream model metadata is corrected.
	for (const candidate of allModels) {
		if (candidate.provider === "amazon-bedrock" && candidate.id.includes("anthropic.claude-opus-4-6-v1")) {
			candidate.cost.cacheRead = 0.5;
			candidate.cost.cacheWrite = 6.25;
		}
		if (
			(candidate.provider === "anthropic" ||
				candidate.provider === "opencode" ||
				candidate.provider === "opencode-go" ||
				candidate.provider === "github-copilot") &&
			(candidate.id === "claude-opus-4-6" ||
				candidate.id === "claude-sonnet-4-6" ||
				candidate.id === "claude-opus-4.6" ||
				candidate.id === "claude-sonnet-4.6")
		) {
			candidate.contextWindow = 1000000;
		}

		// OpenCode variants list Claude Sonnet 4/4.5 with 1M context, actual limit is 200K
		if (
			(candidate.provider === "opencode" || candidate.provider === "opencode-go") &&
			(candidate.id === "claude-sonnet-4-5" || candidate.id === "claude-sonnet-4")
		) {
			candidate.contextWindow = 200000;
		}
		if ((candidate.provider === "opencode" || candidate.provider === "opencode-go") && candidate.id === "gpt-5.4") {
			candidate.contextWindow = 272000;
			candidate.maxTokens = 128000;
		}
		if (candidate.provider === "openai" && (candidate.id === "gpt-5.4" || candidate.id === "gpt-5.5")) {
			candidate.contextWindow = 272000;
			candidate.maxTokens = 128000;
		}
		// Keep selected OpenRouter model metadata stable until upstream settles.
		if (candidate.provider === "openrouter" && candidate.id === "moonshotai/kimi-k2.5") {
			candidate.cost.input = 0.41;
			candidate.cost.output = 2.06;
			candidate.cost.cacheRead = 0.07;
			candidate.maxTokens = 4096;
		}
		if (candidate.provider === "openrouter" && candidate.id === "moonshotai/kimi-k3") {
			candidate.maxTokens = 1048576;
		}
		if (candidate.provider === "openrouter" && candidate.id === "z-ai/glm-5") {
			candidate.cost.input = 0.6;
			candidate.cost.output = 1.9;
			candidate.cost.cacheRead = 0.119;
		}

	}


	// Add missing EU Opus 4.6 profile
	if (!allModels.some((m) => m.provider === "amazon-bedrock" && m.id === "eu.anthropic.claude-opus-4-6-v1")) {
		allModels.push({
			id: "eu.anthropic.claude-opus-4-6-v1",
			name: "Claude Opus 4.6 (EU)",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: getBedrockBaseUrl("eu.anthropic.claude-opus-4-6-v1"),
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 200000,
			maxTokens: 128000,
		});
	}

	// Add missing Claude Opus 4.6
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-opus-4-6")) {
		allModels.push({
			id: "claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// Add missing Claude Opus 4.7
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-opus-4-7")) {
		allModels.push({
			id: "claude-opus-4-7",
			name: "Claude Opus 4.7",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// Add missing Claude Sonnet 4.6
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-sonnet-4-6")) {
		allModels.push({
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 3,
				output: 15,
				cacheRead: 0.3,
				cacheWrite: 3.75,
			},
			contextWindow: 1000000,
			maxTokens: 64000,
		});
	}

	// Add missing Gemini 3.1 Flash Lite Preview until models.dev includes it.
	if (!allModels.some((m) => m.provider === "google" && m.id === "gemini-3.1-flash-lite-preview")) {
		allModels.push({
			id: "gemini-3.1-flash-lite-preview",
			name: "Gemini 3.1 Flash Lite Preview",
			api: "google-generative-ai",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			provider: "google",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1048576,
			maxTokens: 65536,
		});
	}

	if (!allModels.some((m) => m.provider === "google" && m.id === "gemini-3.8-flash")) {
		allModels.push({
			id: "gemini-3.8-flash",
			name: "Gemini 3.8 Flash",
			api: "google-generative-ai",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			provider: "google",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.75,
				output: 3.75,
				cacheRead: 0.075,
				cacheWrite: 0,
			},
			contextWindow: 1048576,
			maxTokens: 65536,
		});
	}

	if (!allModels.some((m) => m.provider === "fireworks" && m.id === "accounts/fireworks/models/deepseek-v4-flash")) {
		allModels.push({
			id: "accounts/fireworks/models/deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "anthropic-messages",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference",
			reasoning: true,
			reasoningCapabilities: {
				control: "budget",
				supportsOff: true,
				levels: { minimal: 1024, low: 2048, medium: 8192, high: 16384 },
			},
			input: ["text"],
			cost: {
				input: 0.14,
				output: 0.28,
				cacheRead: 0.028,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 16384,
		});
	}

	// Add missing gpt models
	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5-chat-latest")) {
		allModels.push({
			id: "gpt-5-chat-latest",
			name: "GPT-5 Chat Latest",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		});
	}

	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5.1-codex")) {
		allModels.push({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 5,
				cacheRead: 0.125,
				cacheWrite: 1.25,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		});
	}

	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5.1-codex-max")) {
		allModels.push({
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1 Codex Max",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		});
	}

	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5.3-codex-spark")) {
		allModels.push({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		});
	}

	// Add missing GitHub Copilot GPT-5.3 models until models.dev includes them.
	const copilotBaseModel = allModels.find(
		(m) => m.provider === "github-copilot" && m.id === "gpt-5.2-codex",
	);
	if (copilotBaseModel) {
		if (!allModels.some((m) => m.provider === "github-copilot" && m.id === "gpt-5.3-codex")) {
			allModels.push({
				...copilotBaseModel,
				id: "gpt-5.3-codex",
				name: "GPT-5.3 Codex",
			});
		}
	}

	if (!allModels.some((m) => m.provider === "openai" && m.id === "gpt-5.4")) {
		allModels.push({
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 2.5,
				output: 15,
				cacheRead: 0.25,
				cacheWrite: 0,
			},
			contextWindow: 272000,
			maxTokens: 128000,
		});
	}

	const deepseekV4Models: Model<"openai-completions">[] = [
		{
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.14,
				output: 0.28,
				cacheRead: 0.0028,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: DEEPSEEK_V4_COMPAT,
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.435,
				output: 0.87,
				cacheRead: 0.003625,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: DEEPSEEK_V4_COMPAT,
		},
	];
	allModels.push(...deepseekV4Models);

	for (const candidate of allModels) {
		if (candidate.api === "openai-completions" && candidate.id.includes("deepseek-v4")) {
			candidate.compat = {
				...candidate.compat,
				...(candidate.provider === "openrouter"
					? {
							requiresReasoningContentOnAssistantMessages:
								DEEPSEEK_V4_COMPAT.requiresReasoningContentOnAssistantMessages,
							thinkingFormat: DEEPSEEK_V4_COMPAT.thinkingFormat,
						}
					: DEEPSEEK_V4_COMPAT),
			};
			if (candidate.provider === "deepseek") {
				mergeThinkingLevelMap(candidate, DEEPSEEK_V4_THINKING_LEVEL_MAP);
			} else if (
				!isOpenRouterDeepSeekV4Route(candidate) &&
				!isPrimeDeepSeekV4Route(candidate) &&
				candidate.provider !== "orcarouter" &&
				!candidate.thinkingLevelMap &&
				!candidate.reasoningCapabilities
			) {
				candidate.thinkingLevelMap = { ...FIXED_REASONING_LEVEL_MAP };
				candidate.reasoningCapabilities = { control: "fixed", levels: { ...FIXED_REASONING_LEVEL_MAP } };
			}
		}
	}

	const minimaxDirectSupportedIds = new Set(["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]);

	for (const candidate of allModels) {
		if (
			(candidate.provider === "minimax" || candidate.provider === "minimax-cn") &&
			minimaxDirectSupportedIds.has(candidate.id)
		) {
			candidate.contextWindow = 204800;
			candidate.maxTokens = 131072;
		}
	}

	for (let i = allModels.length - 1; i >= 0; i--) {
		const candidate = allModels[i];
		if (
			(candidate.provider === "minimax" || candidate.provider === "minimax-cn") &&
			!minimaxDirectSupportedIds.has(candidate.id)
		) {
			allModels.splice(i, 1);
		}
	}

	// OpenAI Codex (ChatGPT OAuth) models
	// NOTE: These are not fetched from models.dev; we keep a small, explicit list to avoid aliases.
	// Context window is based on observed server limits (400s above ~272k), not marketing numbers.
	const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
	const CODEX_CONTEXT = 272000;
	const CODEX_MAX_TOKENS = 128000;
	const codexModels: Model<"openai-codex-responses">[] = [
		{
			id: "gpt-5.1",
			name: "GPT-5.1",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1 Codex Max",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.1-codex-mini",
			name: "GPT-5.1 Codex Mini",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.2",
			name: "GPT-5.2",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.2-codex",
			name: "GPT-5.2 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.3-codex",
			name: "GPT-5.3 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.4-mini",
			name: "GPT-5.4 Mini",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: CODEX_MAX_TOKENS,
		},
	];
	allModels.push(...codexModels);

	// xAI Grok subscription models (OAuth via the Grok CLI proxy)
	allModels.push(...getGrokSubscriptionModels());
	allModels.push(...getAudnModels());
	allModels.push(...getAbliterationModels());

	// Add missing Grok models
	if (!allModels.some(m => m.provider === "xai" && m.id === "grok-code-fast-1")) {
		allModels.push({
			id: "grok-code-fast-1",
			name: "Grok Code Fast 1",
			api: "openai-completions",
			baseUrl: "https://api.x.ai/v1",
			provider: "xai",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0.2,
				output: 1.5,
				cacheRead: 0.02,
				cacheWrite: 0,
			},
			contextWindow: 32768,
			maxTokens: 8192,
		});
	}

	// Add missing Mistral Medium 3.5 model until models.dev includes it
	if (!allModels.some(m => m.provider === "mistral" && m.id === "mistral-medium-3.5")) {
		allModels.push({
			id: "mistral-medium-3.5",
			name: "Mistral Medium 3.5",
			api: "mistral-conversations",
			provider: "mistral",
			baseUrl: "https://api.mistral.ai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.5,
				output: 7.5,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 262144, // 256k tokens
			maxTokens: 262144,
		});
	}

	// Add "auto" alias for openrouter/auto
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "auto")) {
		allModels.push({
			id: "auto",
			name: "Auto",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				// we dont know about the costs because OpenRouter auto routes to different models
				// and then charges you for the underlying used model
				input:0,
				output:0,
				cacheRead:0,
				cacheWrite:0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		});
	}

	if (!allModels.some(m => m.provider === "openrouter" && m.id === "google/gemini-3.8-flash")) {
		allModels.push({
			id: "google/gemini-3.8-flash",
			name: "Google: Gemini 3.8 Flash",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { supportsReasoningEffort: true },
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: null,
				max: null,
			},
			reasoningCapabilities: {
				control: "effort",
				levels: {
					off: null,
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: null,
					max: null,
				},
			},
			input: ["text", "image"],
			cost: {
				input: 0.75,
				output: 3.75,
				cacheRead: 0.075,
				cacheWrite: 0.0416666666666666,
			},
			contextWindow: 1048576,
			maxTokens: 65536,
		});
	}

	if (!allModels.some(m => m.provider === "openrouter" && m.id === "meta/muse-spark-1.3")) {
		allModels.push({
			id: "meta/muse-spark-1.3",
			name: "Meta: Muse Spark 1.3",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { supportsReasoningEffort: true },
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
			reasoningCapabilities: {
				control: "effort",
				levels: {
					off: null,
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: null,
				},
			},
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 4.25,
				cacheRead: 0.15,
				cacheWrite: 0,
			},
			contextWindow: 1048576,
			maxTokens: 943718,
		});
	}

	if (!allModels.some(m => m.provider === "openrouter" && m.id === "meta/muse-spark-1.3-contributor")) {
		allModels.push({
			id: "meta/muse-spark-1.3-contributor",
			name: "Meta: Muse Spark 1.3 Contributor",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { supportsReasoningEffort: true },
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
			reasoningCapabilities: {
				control: "effort",
				levels: {
					off: null,
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: null,
				},
			},
			input: ["text", "image"],
			cost: {
				input: 0.1,
				output: 0.2,
				cacheRead: 0.002,
				cacheWrite: 0,
			},
			contextWindow: 1048576,
			maxTokens: 943718,
		});
	}

	if (!allModels.some(m => m.provider === "orcarouter" && m.id === "orcarouter/auto")) {
		allModels.push(getOrcaRouterAutoModel());
	}

	const VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
	const vertexModels: Model<"google-vertex">[] = [
		{
			id: "gemini-3.8-flash",
			name: "Gemini 3.8 Flash (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-3.7-flash",
			name: "Gemini 3.7 Flash (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-3-pro-preview",
			name: "Gemini 3 Pro Preview (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 64000,
		},
		{
			id: "gemini-3.1-pro-preview",
			name: "Gemini 3.1 Pro Preview (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-3.1-pro-preview-customtools",
			name: "Gemini 3.1 Pro Preview Custom Tools (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-3-flash-preview",
			name: "Gemini 3 Flash Preview (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.0-flash",
			name: "Gemini 2.0 Flash (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 8192,
		},
		{
			id: "gemini-2.0-flash-lite",
			name: "Gemini 2.0 Flash Lite (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-flash-lite-preview-09-2025",
			name: "Gemini 2.5 Flash Lite Preview 09-25 (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-flash-lite",
			name: "Gemini 2.5 Flash Lite (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-1.5-pro",
			name: "Gemini 1.5 Pro (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 1.25, output: 5, cacheRead: 0.3125, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 8192,
		},
		{
			id: "gemini-1.5-flash",
			name: "Gemini 1.5 Flash (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 8192,
		},
		{
			id: "gemini-1.5-flash-8b",
			name: "Gemini 1.5 Flash-8B (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.0375, output: 0.15, cacheRead: 0.01, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 8192,
		},
	];
	allModels.push(...vertexModels);

	const primeInferenceModels = await fetchPrimeInferenceModels();
	allModels.push(...primeInferenceModels);

	const azureOpenAiModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "openai" && model.api === "openai-responses")
		.map((model) => ({
			...model,
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "",
		}));
	allModels.push(...azureOpenAiModels);
	writeGeneratedModels(allModels);
}

function writeGeneratedModels(allModels: Model<any>[], preserveCatalog = false): void {
	for (const model of allModels) {
		if (preserveCatalog) {
			updatePreservedReasoningMetadata(model);
		} else {
			applyThinkingLevelMetadata(model);
			updatePreservedReasoningMetadata(model);
		}
		syncLegacyThinkingLevelMap(model);
		assertValidReasoningCapabilities(model);
	}

	// Group by provider and deduplicate by model ID
	const providers: Record<string, Record<string, Model<Api>>> = {};
	for (const model of allModels) {
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		// Use model ID as key to automatically deduplicate
		// Only add if not already present (models.dev takes priority over OpenRouter)
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	// Generate TypeScript file. JSON string literals prevent remote catalog
	// text from becoming executable source code.
	const output = renderModelsFile(providers);

	// Write file
	writeFileSync(join(packageRoot, "src/models.generated.ts"), output);
	console.log("Generated src/models.generated.ts");

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

// Run the generator
generateModels().catch(console.error);
