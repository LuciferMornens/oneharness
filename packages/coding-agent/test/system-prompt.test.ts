import { describe, expect, test } from "vitest";
import { buildRlmPrompt } from "../src/core/prompts/index.js";

describe("buildRlmPrompt", () => {
	test("discovers requested models through a bounded authenticated host search", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
		});

		expect(prompt).toContain("await rlm.find_models(...)");
		expect(prompt).toContain("exact returned selector");
		expect(prompt).toContain("each match includes `reasoning_levels`");
		expect(prompt).toContain("thinking='xhigh'");
		expect(prompt).toContain("off`/`minimal`/`low`/`medium`/`high`/`max");
		expect(prompt).toContain("An unavailable model or unsupported level fails spawn");
		expect(prompt).toContain("decide whether to retry or omit `model`/`thinking`");
		expect(prompt).not.toContain("model choices for subagents");
	});
});
