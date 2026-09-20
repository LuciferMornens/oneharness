import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";

describe("Google mandatory thinking contracts", () => {
	it("does not advertise off and splits Gemini 3 Pro effort levels by generation", () => {
		for (const provider of ["google", "google-vertex"] as const) {
			expect(getSupportedThinkingLevels(getModel(provider, "gemini-3-flash-preview"))).not.toContain("off");
			expect(getSupportedThinkingLevels(getModel(provider, "gemini-3.1-pro-preview"))).toEqual([
				"low",
				"medium",
				"high",
			]);
			expect(getSupportedThinkingLevels(getModel(provider, "gemini-3.8-flash"))).toEqual(["low", "medium", "high"]);
		}
		expect(getSupportedThinkingLevels(getModel("google-vertex", "gemini-3-pro-preview"))).toEqual(["low", "high"]);
		expect(getSupportedThinkingLevels(getModel("google", "gemini-flash-latest"))).toEqual(["low", "medium", "high"]);
		expect(getSupportedThinkingLevels(getModel("google", "gemini-flash-lite-latest"))).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});
});
