import { describe, expect, it } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";

describe("cursor provider catalog", () => {
	it("registers Composer and Auto from the Cursor CLI catalog", () => {
		const composer = getModel("cursor", "composer-2.5");
		expect(composer.api).toBe("openai-completions");
		expect(composer.baseUrl).toBe("https://api.cursor.com/v1");
		expect(composer.provider).toBe("cursor");

		const auto = getModel("cursor", "auto");
		expect(auto.name).toBe("Auto");
	});

	it("resolves CURSOR_API_KEY", () => {
		const previous = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "test-cursor-key";
		try {
			expect(getEnvApiKey("cursor")).toBe("test-cursor-key");
		} finally {
			if (previous === undefined) {
				delete process.env.CURSOR_API_KEY;
			} else {
				process.env.CURSOR_API_KEY = previous;
			}
		}
	});
});
