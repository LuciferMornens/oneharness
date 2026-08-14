import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { type MistralOptions, streamMistral } from "../src/providers/mistral.js";
import { streamSimple } from "../src/stream.js";
import type { Context, Model, SimpleStreamOptions } from "../src/types.js";

interface MistralPayload {
	promptMode?: "reasoning";
	reasoningEffort?: "none" | "high";
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"mistral-conversations">,
	options?: SimpleStreamOptions,
): Promise<MistralPayload> {
	let capturedPayload: MistralPayload | undefined;
	const payloadCaptureModel: Model<"mistral-conversations"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const stream = streamSimple(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as MistralPayload;
			return payload;
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

async function captureDirectPayload(
	model: Model<"mistral-conversations">,
	options: MistralOptions,
): Promise<MistralPayload> {
	let capturedPayload: MistralPayload | undefined;
	const stream = streamMistral({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as MistralPayload;
			return payload;
		},
	});

	await stream.result();
	if (!capturedPayload) throw new Error("Expected payload to be captured before request failure");
	return capturedPayload;
}

describe("Mistral reasoning mode selection", () => {
	it("uses reasoning_effort for Mistral Small 4", async () => {
		const payload = await capturePayload(getModel("mistral", "mistral-small-2603"), { reasoning: "medium" });

		expect(payload.reasoningEffort).toBe("high");
		expect(payload.promptMode).toBeUndefined();
	});

	it("preserves the Mistral Small 4 default when reasoning is omitted", async () => {
		const payload = await capturePayload(getModel("mistral", "mistral-small-2603"));

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("serializes explicit off for adjustable Mistral reasoning", async () => {
		const payload = await capturePayload(getModel("mistral", "mistral-small-2603"), { reasoning: "off" });

		expect(payload.reasoningEffort).toBe("none");
		expect(payload.promptMode).toBeUndefined();
	});

	it("honors the direct Mistral reasoning effort value override", async () => {
		const payload = await captureDirectPayload(getModel("mistral", "mistral-small-2603"), {
			reasoningEffort: "high",
			reasoningEffortValue: "none",
		});

		expect(payload.reasoningEffort).toBe("none");
	});

	it("rejects numeric budget contracts before building a Mistral request", async () => {
		let payloadBuilt = false;
		const model: Model<"mistral-conversations"> = {
			...getModel("mistral", "mistral-small-2603"),
			provider: "custom-budget",
			baseUrl: "http://127.0.0.1:9",
			reasoningCapabilities: { control: "budget", levels: { off: 0, high: 8192 } },
		};

		const result = await streamMistral(model, makeContext(), {
			apiKey: "fake-key",
			reasoningEffort: "high",
			onPayload: () => {
				payloadBuilt = true;
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(
			'API "mistral-conversations" accepts only string reasoning effort values and cannot serialize a numeric reasoning budget',
		);
		expect(payloadBuilt).toBe(false);
	});

	it("ignores direct reasoning controls for non-reasoning models", async () => {
		const payload = await captureDirectPayload(
			{ ...getModel("mistral", "mistral-small-2603"), reasoning: false },
			{
				promptMode: "reasoning",
				reasoningEffort: "high",
				reasoningEffortValue: "none",
			},
		);

		expect(payload.promptMode).toBeUndefined();
		expect(payload.reasoningEffort).toBeUndefined();
	});

	it("keeps native Magistral reasoning fixed without a synthetic off control", async () => {
		const model = getModel("mistral", "magistral-medium-latest");
		expect(model.reasoningCapabilities).toEqual({
			control: "fixed",
			levels: { off: null, minimal: null, low: null, medium: null, high: "always", xhigh: null, max: null },
		});

		for (const reasoning of ["off", "medium"] as const) {
			const payload = await capturePayload(model, { reasoning });
			expect(payload.promptMode).toBeUndefined();
			expect(payload.reasoningEffort).toBeUndefined();
		}

		const direct = await captureDirectPayload(model, { promptMode: "reasoning" });
		expect(direct.promptMode).toBeUndefined();
	});

	it("uses reasoning_effort for Mistral Medium 3.5 aliases and legacy custom maps", async () => {
		const medium35 = getModel("mistral", "mistral-medium-3.5");
		const models: Model<"mistral-conversations">[] = [
			medium35,
			getModel("mistral", "mistral-medium-2604"),
			getModel("mistral", "mistral-medium-latest"),
			{
				...medium35,
				id: "mistral-medium-3-5",
				reasoningCapabilities: undefined,
				thinkingLevelMap: { high: "high" },
			},
		];

		for (const model of models) {
			const payload = await capturePayload(model, { reasoning: "medium" });
			expect(payload.reasoningEffort).toBe("high");
			expect(payload.promptMode).toBeUndefined();
		}
	});

	it("preserves Mistral Medium defaults when reasoning is omitted", async () => {
		for (const modelId of ["mistral-medium-3.5", "mistral-medium-2604", "mistral-medium-latest"] as const) {
			const payload = await capturePayload(getModel("mistral", modelId));
			expect(payload.reasoningEffort).toBeUndefined();
			expect(payload.promptMode).toBeUndefined();
		}
	});
});
