import { afterEach, describe, expect, it, vi } from "vitest";
import { grokOAuthProvider, loginGrok, refreshGrokToken } from "../src/utils/oauth/grok.js";
import { getOAuthProvider } from "../src/utils/oauth/index.js";

const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function deviceCodeResponse(overrides: Record<string, unknown> = {}): Response {
	return jsonResponse({
		device_code: "device-code",
		user_code: "ABCD-1234",
		verification_uri: "https://accounts.x.ai/activate",
		verification_uri_complete: "https://accounts.x.ai/activate?user_code=ABCD-1234",
		interval: 1,
		expires_in: 900,
		...overrides,
	});
}

describe("xAI Grok OAuth device flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("is registered as a built-in OAuth provider", () => {
		const provider = getOAuthProvider("grok");
		expect(provider).toBe(grokOAuthProvider);
		expect(provider?.name).toContain("xAI Grok");
	});

	it("completes the device flow and returns credentials", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const tokenPollTimes: number[] = [];
		const tokenResponses = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === DEVICE_CODE_URL) {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				});
				const body = String(init?.body);
				expect(body).toContain("client_id=b1a00492-073a-47ea-816f-4c329264a828");
				expect(body).toContain("scope=openid+profile+email+offline_access+grok-cli%3Aaccess+api%3Aaccess");
				return deviceCodeResponse();
			}

			if (url === TOKEN_URL) {
				tokenPollTimes.push(Date.now());
				const body = String(init?.body);
				expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
				expect(body).toContain("device_code=device-code");
				expect(body).toContain("client_id=b1a00492-073a-47ea-816f-4c329264a828");
				const response = tokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra token poll");
				}
				return response;
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		const loginPromise = loginGrok({
			onAuth: (url, instructions) => {
				authUrl = url;
				authInstructions = instructions;
			},
		});

		await vi.advanceTimersByTimeAsync(1000);
		expect(tokenPollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1000);
		const credentials = await loginPromise;

		expect(authUrl).toBe("https://accounts.x.ai/activate?user_code=ABCD-1234");
		expect(authInstructions).toContain("ABCD-1234");
		expect(tokenPollTimes).toEqual([startTime.getTime() + 1000, startTime.getTime() + 2000]);
		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(credentials.expires).toBe(startTime.getTime() + 2000 + 3600 * 1000 - 5 * 60 * 1000);
	});

	it("honors slow_down responses and the server-requested interval", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const tokenPollTimes: number[] = [];
		const tokenResponses = [
			jsonResponse({ error: "slow_down", interval: 10 }, 400),
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
		];

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === DEVICE_CODE_URL) {
				return deviceCodeResponse();
			}
			if (url === TOKEN_URL) {
				tokenPollTimes.push(Date.now());
				const response = tokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra token poll");
				}
				return response;
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginGrok({ onAuth: () => {} });

		await vi.advanceTimersByTimeAsync(1000);
		expect(tokenPollTimes).toHaveLength(1);

		// slow_down: interval grows to the requested 10 seconds
		await vi.advanceTimersByTimeAsync(9999);
		expect(tokenPollTimes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(tokenPollTimes).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(10000);
		const credentials = await loginPromise;

		expect(tokenPollTimes).toEqual([
			startTime.getTime() + 1000,
			startTime.getTime() + 11000,
			startTime.getTime() + 21000,
		]);
		expect(credentials.access).toBe("access-token");
	});

	it("throws when authorization is denied", async () => {
		vi.useFakeTimers();

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === DEVICE_CODE_URL) {
				return deviceCodeResponse();
			}
			if (url === TOKEN_URL) {
				return jsonResponse({ error: "access_denied" }, 400);
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginGrok({ onAuth: () => {} });
		const rejection = expect(loginPromise).rejects.toThrow(/denied/);
		await vi.advanceTimersByTimeAsync(1000);
		await rejection;
	});

	it("throws when the device code expires", async () => {
		vi.useFakeTimers();

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === DEVICE_CODE_URL) {
				return deviceCodeResponse();
			}
			if (url === TOKEN_URL) {
				return jsonResponse({ error: "expired_token" }, 400);
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginGrok({ onAuth: () => {} });
		const rejection = expect(loginPromise).rejects.toThrow(/expired/);
		await vi.advanceTimersByTimeAsync(1000);
		await rejection;
	});

	it("supports cancellation through an abort signal", async () => {
		vi.useFakeTimers();

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === DEVICE_CODE_URL) {
				return deviceCodeResponse();
			}
			if (url === TOKEN_URL) {
				return jsonResponse({ error: "authorization_pending" }, 400);
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const controller = new AbortController();
		const loginPromise = loginGrok({ onAuth: () => {}, signal: controller.signal });
		const rejection = expect(loginPromise).rejects.toThrow(/cancelled/i);

		await vi.advanceTimersByTimeAsync(1000);
		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);
		await rejection;
	});

	it("aborts an in-flight token poll immediately", async () => {
		vi.useFakeTimers();

		let tokenSignal: AbortSignal | undefined;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === DEVICE_CODE_URL) {
				return deviceCodeResponse();
			}
			if (url === TOKEN_URL) {
				tokenSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				});
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const controller = new AbortController();
		const loginPromise = loginGrok({ onAuth: () => {}, signal: controller.signal });
		const rejection = expect(loginPromise).rejects.toThrow(/cancelled/i);

		// Enter the first token poll, then cancel while the request is in flight.
		await vi.advanceTimersByTimeAsync(1000);
		expect(tokenSignal).toBeDefined();
		expect(tokenSignal?.aborted).toBe(false);
		controller.abort();
		await rejection;
		expect(tokenSignal?.aborted).toBe(true);
	});

	it("aborts an in-flight device authorization request immediately", async () => {
		let deviceSignal: AbortSignal | undefined;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === DEVICE_CODE_URL) {
				deviceSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				});
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const controller = new AbortController();
		const loginPromise = loginGrok({ onAuth: () => {}, signal: controller.signal });
		const rejection = expect(loginPromise).rejects.toThrow(/cancelled/i);

		controller.abort();
		await rejection;
		expect(deviceSignal?.aborted).toBe(true);
	});

	it("falls back to the plain verification URI when the prefilled one is unsafe", async () => {
		vi.useFakeTimers();

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === DEVICE_CODE_URL) {
				return deviceCodeResponse({
					verification_uri_complete: "https://accounts.x.ai/activate?code=device-code",
				});
			}
			if (url === TOKEN_URL) {
				return jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		let authUrl: string | undefined;
		const loginPromise = loginGrok({
			onAuth: (url) => {
				authUrl = url;
			},
		});

		await vi.advanceTimersByTimeAsync(1000);
		await loginPromise;

		expect(authUrl).toBe("https://accounts.x.ai/activate");
	});

	it("rejects verification URIs outside the xAI auth origins", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === DEVICE_CODE_URL) {
				return deviceCodeResponse({ verification_uri: "https://evil.example.com/activate" });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		await expect(loginGrok({ onAuth: () => {} })).rejects.toThrow(/invalid schema/);
	});
});

describe("xAI Grok OAuth token refresh", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("refreshes tokens with the refresh grant and rotates the refresh token", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			expect(url).toBe(TOKEN_URL);
			const body = String(init?.body);
			expect(body).toContain("grant_type=refresh_token");
			expect(body).toContain("refresh_token=old-refresh");
			expect(body).toContain("client_id=b1a00492-073a-47ea-816f-4c329264a828");
			return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshGrokToken("old-refresh");
		expect(credentials.access).toBe("new-access");
		expect(credentials.refresh).toBe("new-refresh");
		expect(credentials.expires).toBe(startTime.getTime() + 1800 * 1000 - 5 * 60 * 1000);
	});

	it("keeps the previous refresh token when the response omits one", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			return jsonResponse({ access_token: "new-access", expires_in: 1800 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshGrokToken("old-refresh");
		expect(credentials.access).toBe("new-access");
		expect(credentials.refresh).toBe("old-refresh");
	});

	it("fails clearly when no refresh token is stored", async () => {
		await expect(refreshGrokToken("")).rejects.toThrow(/refresh token/);
	});

	it("fails clearly when the refresh request is rejected", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			return jsonResponse({ error: "invalid_grant" }, 400);
		});

		vi.stubGlobal("fetch", fetchMock);

		await expect(refreshGrokToken("old-refresh")).rejects.toThrow(/status 400/);
	});

	it("routes provider refreshToken and getApiKey through the credential shape", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const refreshed = await grokOAuthProvider.refreshToken({
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
		});
		expect(refreshed.access).toBe("new-access");
		expect(grokOAuthProvider.getApiKey(refreshed)).toBe("new-access");
	});
});
