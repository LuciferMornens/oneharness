import { describe, expect, test } from "vitest";
import { defaultModelPerProvider } from "../src/core/model-resolver.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.js";

describe("abliteration.ai provider wiring", () => {
	test("default model is abliterated-model-large-v2", () => {
		expect(defaultModelPerProvider.abliteration).toBe("abliterated-model-large-v2");
	});

	test("login display name is abliteration.ai", () => {
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES.abliteration).toBe("abliteration.ai");
	});
});
