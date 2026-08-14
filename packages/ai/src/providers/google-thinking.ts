import type {
	ModelReasoningCapabilities,
	ModelThinkingLevel,
	ReasoningBudgetLevelMap,
	ReasoningEffortLevelMap,
	ThinkingBudgets,
	ThinkingLevelMap,
} from "../types.js";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

type GoogleBudgetThinkingLevel = "minimal" | "low" | "medium" | "high";

function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
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

function isGemini35FlashAlias(modelId: string): boolean {
	return modelId.toLowerCase() === "gemini-flash-latest";
}

function isGemini35FlashLiteAlias(modelId: string): boolean {
	return modelId.toLowerCase() === "gemini-flash-lite-latest";
}

function isGemini37FlashModel(modelId: string): boolean {
	return /^gemini-3\.7-flash(?:-\d{3}|-preview(?:-\d{2}-\d{4})?)?$/.test(modelId.toLowerCase());
}

export function usesGoogleThinkingLevels(modelId: string): boolean {
	return (
		isGemini3ProModel(modelId) ||
		isGemini3FlashModel(modelId) ||
		isGemini35FlashAlias(modelId) ||
		isGemini35FlashLiteAlias(modelId) ||
		isGemma4Model(modelId)
	);
}

export function getLegacyGoogleDisabledThinking(modelId: string): {
	budgetTokens?: number;
	level?: GoogleThinkingLevel;
} {
	if (isGemini3ProModel(modelId)) return { level: "LOW" };
	if (isGemini37FlashModel(modelId)) return { level: "LOW" };
	if (isGemini3FlashModel(modelId) || isGemma4Model(modelId)) return { level: "MINIMAL" };
	if (isGemini35FlashAlias(modelId) || isGemini35FlashLiteAlias(modelId)) return { level: "MINIMAL" };
	return { budgetTokens: 0 };
}

export function getLegacyGoogleThinkingLevel(modelId: string, effort: GoogleBudgetThinkingLevel): GoogleThinkingLevel {
	if (isGemini3ProModel(modelId)) {
		if (effort === "minimal" || effort === "low") return "LOW";
		return effort === "medium" && supportsGemini3ProMedium(modelId) ? "MEDIUM" : "HIGH";
	}
	if (isGemini37FlashModel(modelId)) {
		if (effort === "minimal" || effort === "low") return "LOW";
		return effort === "medium" ? "MEDIUM" : "HIGH";
	}
	if (isGemma4Model(modelId)) {
		return effort === "minimal" || effort === "low" ? "MINIMAL" : "HIGH";
	}
	return { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }[effort] as GoogleThinkingLevel;
}

export function getGoogleThinkingBudget(
	modelId: string,
	effort: GoogleBudgetThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	if (modelId.includes("2.5-pro")) {
		return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[effort];
	}

	if (modelId.includes("2.5-flash-lite")) {
		return { minimal: 512, low: 2048, medium: 8192, high: 24576 }[effort];
	}

	if (modelId.includes("2.5-flash")) {
		return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[effort];
	}

	return -1;
}

/** Provider-native defaults used to fill missing legacy thinkingLevelMap entries. */
export function getLegacyGoogleReasoningLevels(modelId: string): ModelReasoningCapabilities {
	if (isGemini3ProModel(modelId)) {
		return {
			control: "effort",
			levels: {
				off: null,
				minimal: null,
				low: "LOW",
				medium: supportsGemini3ProMedium(modelId) ? "MEDIUM" : null,
				high: "HIGH",
				xhigh: null,
				max: null,
			},
		};
	}
	if (isGemini37FlashModel(modelId)) {
		return {
			control: "effort",
			levels: {
				off: null,
				minimal: null,
				low: "LOW",
				medium: "MEDIUM",
				high: "HIGH",
				xhigh: null,
				max: null,
			},
		};
	}
	if (isGemma4Model(modelId)) {
		return {
			control: "effort",
			levels: { off: "MINIMAL", minimal: null, low: null, medium: null, high: "HIGH" },
		};
	}
	if (usesGoogleThinkingLevels(modelId)) {
		return {
			control: "effort",
			levels: {
				off: null,
				minimal: "MINIMAL",
				low: "LOW",
				medium: "MEDIUM",
				high: "HIGH",
				xhigh: null,
				max: null,
			},
		};
	}

	if (modelId.toLowerCase().includes("2.5-pro")) {
		return {
			control: "budget",
			levels: { off: null, minimal: 128, low: 2048, medium: 8192, high: 32768, xhigh: null, max: null },
		};
	}
	if (modelId.toLowerCase().includes("2.5-flash-lite")) {
		return {
			control: "budget",
			levels: { off: 0, minimal: 512, low: 2048, medium: 8192, high: 24576, xhigh: null, max: null },
		};
	}
	if (modelId.toLowerCase().includes("2.5-flash")) {
		return {
			control: "budget",
			levels: { off: 0, minimal: 128, low: 2048, medium: 8192, high: 24576, xhigh: null, max: null },
		};
	}
	return { control: "budget", levels: { off: 0, high: -1 } };
}

/** Merge a string-only legacy map over Google defaults without flipping budget contracts. */
export function overlayLegacyGoogleLevels(
	defaults: ModelReasoningCapabilities,
	map: ThinkingLevelMap,
): ModelReasoningCapabilities {
	if (defaults.control !== "budget") {
		return {
			...defaults,
			levels: { ...defaults.levels, ...map } as ReasoningEffortLevelMap,
		};
	}

	const levels: ReasoningBudgetLevelMap = { ...defaults.levels };
	for (const [level, value] of Object.entries(map) as [ModelThinkingLevel, string | null | undefined][]) {
		if (value === null) levels[level] = null;
	}
	return { control: "budget", levels };
}
