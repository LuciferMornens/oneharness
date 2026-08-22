import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import { createHarness, type Harness } from "../harness.js";

function completedWithoutReplyMessages(messages: readonly unknown[]): unknown[] {
	return messages.filter((message) => {
		const content = (message as { content?: unknown }).content;
		return typeof content === "string" && content.includes("completed without sending a reply");
	});
}

function attributedTerminalMessage(messages: readonly unknown[]): AgentSessionMessage | undefined {
	return messages.find((message): message is AgentSessionMessage => {
		if (typeof message !== "object" || message === null) return false;
		const content = "content" in message ? (message as { content?: unknown }).content : undefined;
		return (
			"role" in message &&
			"customType" in message &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === AGENT_MESSAGE_CUSTOM_TYPE &&
			typeof content === "string" &&
			content.includes("completed without sending a reply")
		);
	});
}

describe("#1637 still-live RLM children are not marked completed without reply", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;
	let nested: Harness | undefined;

	afterEach(() => {
		nested?.cleanup();
		child?.cleanup();
		parent?.cleanup();
		nested = undefined;
		child = undefined;
		parent = undefined;
	});

	it("holds the silent-completion notice until leftover nested work ends", async () => {
		let releaseChild: (message: ReturnType<typeof fauxAssistantMessage>) => void = () => {};
		const childGate = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			releaseChild = resolve;
		});
		let releaseNested: (message: ReturnType<typeof fauxAssistantMessage>) => void = () => {};
		const nestedGate = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			releaseNested = resolve;
		});
		const completeChild = vi.fn(() => true);

		nested = await createHarness();
		nested.setResponses([async () => nestedGate]);
		child = await createHarness({
			rlmDepth: 1,
			rlmMaxDepth: 2,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: nested!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async (input) => {
					const message = createAgentSessionMessage({
						id: `agentmsg-${Date.now()}`,
						source: "agent_message",
						message: input.message,
						from: {
							activeSessionId: "child-active",
							sessionId: child!.session.sessionId,
							sessionName: "finish2",
						},
						fromRelationship: "child",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
					});
					await parent!.session.acceptAgentMessagePrompt(message.content, { customMessage: message });
					return {
						id: message.details.id,
						source: "agent_message",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
						message: input.message,
						deliveryStatus: "delivered",
					};
				},
			},
		});
		child.setResponses([async () => childGate, fauxAssistantMessage("ack nested notice")]);
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 2,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				completeRlmSubagentRuntime: completeChild,
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const spawned = await parent.session.runRlmChild("finish without replying", { name: "finish2" });
		await expect.poll(() => parent!.session.getRlmChildSession(spawned.rlm_child_id)).not.toBeUndefined();
		await child.session.runRlmChild("still working", { name: "finish1" });
		await expect.poll(() => nested!.session.isStreaming).toBe(true);

		releaseChild(fauxAssistantMessage("child first turn"));
		await expect.poll(() => child!.session.getLastAssistantText()).toBe("child first turn");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(completedWithoutReplyMessages(parent.session.messages)).toHaveLength(0);
		expect(parent.session.getRlmChildRunStatus(spawned.rlm_child_id)).toBe("running");
		expect(completeChild).not.toHaveBeenCalled();
		expect(child.session.hasLiveRlmSessionWork()).toBe(true);

		releaseNested(fauxAssistantMessage("nested finished"));
		await expect.poll(() => completedWithoutReplyMessages(parent!.session.messages)).toHaveLength(1);
		expect(attributedTerminalMessage(parent.session.messages)?.content).toContain(spawned.rlm_child_id);
		expect(completeChild).toHaveBeenCalledWith(spawned.rlm_child_id, child.session);
	});

	it("still notices a one-turn silent child", async () => {
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async (input) => {
					const message = createAgentSessionMessage({
						id: "agentmsg-silent-or-reply",
						source: "agent_message",
						message: input.message,
						from: {
							activeSessionId: "child-active",
							sessionId: child!.session.sessionId,
							sessionName: "one-turn-worker",
						},
						fromRelationship: "child",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
					});
					await parent!.session.acceptAgentMessagePrompt(message.content, { customMessage: message });
					return {
						id: message.details.id,
						source: "agent_message",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
						message: input.message,
						deliveryStatus: "delivered",
					};
				},
			},
		});
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		child.setResponses([fauxAssistantMessage("child completed")]);

		const spawned = await parent.session.runRlmChild("finish without replying", { name: "one-turn-worker" });
		await expect.poll(() => completedWithoutReplyMessages(parent!.session.messages).length).toBeGreaterThan(0);
		expect(completedWithoutReplyMessages(parent.session.messages)).toHaveLength(1);
		expect(attributedTerminalMessage(parent.session.messages)?.content).toContain(spawned.rlm_child_id);
	});
});
