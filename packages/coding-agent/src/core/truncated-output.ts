import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

/** Consecutive auto-continues after an output-limit stop with no text or tool call. */
export const MAX_TRUNCATED_OUTPUT_CONTINUATIONS = 2;

export const TRUNCATED_OUTPUT_CONTINUATION_PROMPT =
	"Output token limit reached before any action: the previous response ended while still reasoning and produced no text and no tool call. Do not re-plan or restart the analysis. Take the next concrete step now: make a tool call, or reply with a short text answer if the task is complete.";

/** True when the model spent the whole output limit thinking and produced nothing actionable. */
export function isActionlessTruncation(message: AssistantMessage): boolean {
	if (message.stopReason !== "length") return false;
	return !message.content.some(
		(block) => block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0),
	);
}

export function createTruncatedOutputContinuation(timestamp = Date.now()): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text: TRUNCATED_OUTPUT_CONTINUATION_PROMPT }],
		timestamp,
	};
}
