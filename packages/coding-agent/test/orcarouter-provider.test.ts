import { describe, expect, test } from "vitest";
import { defaultModelPerProvider } from "../src/core/model-resolver.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.js";

describe("OrcaRouter provider wiring", () => {
	test("default model is orcarouter/auto", () => {
		expect(defaultModelPerProvider.orcarouter).toBe("orcarouter/auto");
	});

	test("login display name is OrcaRouter", () => {
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES.orcarouter).toBe("OrcaRouter");
	});
});
