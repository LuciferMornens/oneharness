import { describe, expect, test } from "vitest";
import { defaultModelPerProvider } from "../src/core/model-resolver.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.js";

describe("audn.ai provider wiring", () => {
	test("default model is necromicon", () => {
		expect(defaultModelPerProvider.audn).toBe("necromicon");
	});

	test("login display name is audn.ai", () => {
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES.audn).toBe("audn.ai");
	});
});
