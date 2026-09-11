import { describe, expect, test } from "vitest";
import { defaultModelPerProvider } from "../src/core/model-resolver.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.js";

describe("adverserial.ai provider wiring", () => {
	test("default model is lordx64/cyberkimi", () => {
		expect(defaultModelPerProvider.adverserial).toBe("lordx64/cyberkimi");
	});

	test("login display name is Adverserial AI", () => {
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES.adverserial).toBe("Adverserial AI");
	});
});
