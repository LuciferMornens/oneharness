import { getReasoningCapabilities } from "../models.js";
import type { Api, Model, SimpleStreamOptions, StreamOptions, ThinkingBudgets, ThinkingLevel } from "../types.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 32000;

/**
 * Claude Fable/Mythos 5.x and GPT-6 run adaptive thinking that is always on and
 * billed against the output limit, with no separate thinking budget the harness
 * could reserve room from. A 32k default lets a high-effort turn spend the whole
 * limit on thinking and stop with `length` before any text or tool call, so these
 * families get their full output limit (128k).
 */
function usesFullOutputLimit(model: Model<Api>): boolean {
	if (getReasoningCapabilities(model)?.control !== "effort") return false;
	return /claude-(?:fable|mythos)-5|gpt-6/.test(model.id.toLowerCase());
}

export function resolveDefaultMaxTokens(model: Model<Api>): number | undefined {
	if (model.maxTokens <= 0) return undefined;
	return usesFullOutputLimit(model) ? model.maxTokens : Math.min(model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
}

export function buildBaseOptions(model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string): StreamOptions {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens ?? resolveDefaultMaxTokens(model),
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		transport: options?.transport,
		serviceTier: options?.serviceTier,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		timeoutMs: options?.timeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};
}

export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

export function adjustMaxTokensForThinking(
	baseMaxTokens: number,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}
