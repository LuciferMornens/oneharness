import { fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE } from "../../src/core/messages.js";
import {
	isActionlessTruncation,
	MAX_TRUNCATED_OUTPUT_CONTINUATIONS,
	TRUNCATED_OUTPUT_CONTINUATION_PROMPT,
} from "../../src/core/truncated-output.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.js";

function thinkingOnlyLengthStop(): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([fauxThinking("still planning every edge case...")], { stopReason: "length" });
}

function terminalNotices(messages: readonly unknown[]): string[] {
	return messages
		.filter(
			(message): message is { role: string; customType: string; content: string } =>
				typeof message === "object" &&
				message !== null &&
				(message as { role?: unknown }).role === "custom" &&
				(message as { customType?: unknown }).customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE &&
				typeof (message as { content?: unknown }).content === "string",
		)
		.map((message) => message.content);
}

describe("AgentSession truncated output continuation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("classifies only length stops without text or tool calls as actionless", () => {
		expect(isActionlessTruncation(thinkingOnlyLengthStop())).toBe(true);
		expect(isActionlessTruncation(fauxAssistantMessage("partial answer", { stopReason: "length" }))).toBe(false);
		expect(isActionlessTruncation(fauxAssistantMessage([fauxThinking("done thinking")]))).toBe(false);
	});

	it("auto-continues after the model spends the whole output limit thinking", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([thinkingOnlyLengthStop(), fauxAssistantMessage("Implemented the chart.")]);

		await harness.session.prompt("build the chart");

		expect(getUserTexts(harness)).toEqual(["build the chart", TRUNCATED_OUTPUT_CONTINUATION_PROMPT]);
		expect(getAssistantTexts(harness)).toEqual(["", "Implemented the chart."]);
	});

	it("stops nudging after the continuation limit", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			thinkingOnlyLengthStop(),
			thinkingOnlyLengthStop(),
			thinkingOnlyLengthStop(),
			fauxAssistantMessage("never reached"),
		]);

		await harness.session.prompt("build the chart");

		expect(getUserTexts(harness)).toEqual([
			"build the chart",
			...Array.from({ length: MAX_TRUNCATED_OUTPUT_CONTINUATIONS }, () => TRUNCATED_OUTPUT_CONTINUATION_PROMPT),
		]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("resets the continuation limit on the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([thinkingOnlyLengthStop(), thinkingOnlyLengthStop(), thinkingOnlyLengthStop()]);
		await harness.session.prompt("first");
		expect(harness.getPendingResponseCount()).toBe(0);

		harness.setResponses([thinkingOnlyLengthStop(), fauxAssistantMessage("recovered")]);
		await harness.session.prompt("second");

		expect(getAssistantTexts(harness).at(-1)).toBe("recovered");
		expect(getUserTexts(harness).filter((text) => text === TRUNCATED_OUTPUT_CONTINUATION_PROMPT)).toHaveLength(
			MAX_TRUNCATED_OUTPUT_CONTINUATIONS + 1,
		);
	});

	it("does not continue a length stop that already produced text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Here is the first half of the answer", { stopReason: "length" }),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("explain");

		expect(getUserTexts(harness)).toEqual(["explain"]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("reports the last stop reason when a subagent completes without a reply", async () => {
		const child = await createHarness();
		harnesses.push(child);
		const parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		harnesses.push(parent);
		child.setResponses(
			Array.from({ length: MAX_TRUNCATED_OUTPUT_CONTINUATIONS + 1 }, () => thinkingOnlyLengthStop()),
		);

		const spawned = await parent.session.runRlmChild("do the work", { name: "worker" });
		await expect.poll(() => terminalNotices(parent.session.messages)).toHaveLength(1);

		const notice = terminalNotices(parent.session.messages)[0]!;
		expect(notice).toContain(spawned.rlm_child_id);
		expect(notice).toContain("completed without sending a reply");
		expect(notice).toContain("last stop reason: length");
	});
});
