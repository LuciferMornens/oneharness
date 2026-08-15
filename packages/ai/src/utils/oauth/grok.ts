/**
 * xAI Grok OAuth flow (SuperGrok / X Premium+ subscriptions)
 *
 * Uses the OAuth 2.0 device authorization grant against accounts.x.ai,
 * matching the official Grok CLI client. The resulting bearer token is
 * consumed by the "grok-responses" provider, which talks to xAI's
 * subscription CLI proxy instead of the pay-per-token api.x.ai surface.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const ISSUER = "https://auth.x.ai";
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
// Client ID of the official Grok CLI. Subscription inference is only enabled
// for this client on xAI's side.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const VERIFICATION_ORIGINS = new Set([ISSUER, "https://accounts.x.ai"]);

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const MAX_LOGIN_DURATION_MS = 15 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;

type DeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** verification_uri with the user code prefilled, when the server provides one. */
	verificationUriComplete?: string;
	intervalSeconds: number;
	expiresInSeconds: number;
};

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
	interval?: number;
};

function formHeaders(): Record<string, string> {
	return {
		Accept: "application/json",
		"Content-Type": "application/x-www-form-urlencoded",
	};
}

async function postForm(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<Response> {
	try {
		return await fetch(url, {
			method: "POST",
			headers: formHeaders(),
			body: new URLSearchParams(form).toString(),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error(`${label} returned invalid JSON (status ${response.status})`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`${label} returned an unexpected response shape`);
	}
	return data as Record<string, unknown>;
}

function validateVerificationUri(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "https:" || !VERIFICATION_ORIGINS.has(parsed.origin)) return undefined;
		return parsed.toString();
	} catch {
		return undefined;
	}
}

async function startDeviceFlow(signal?: AbortSignal): Promise<DeviceAuthorization> {
	const response = await postForm(
		DEVICE_CODE_URL,
		{
			client_id: CLIENT_ID,
			scope: SCOPE,
		},
		signal,
	);

	if (!response.ok) {
		throw new Error(`xAI device authorization request failed with status ${response.status}`);
	}

	const data = await readJson(response, "xAI device authorization response");
	const deviceCode = data.device_code;
	const userCode = data.user_code;
	const verificationUri = validateVerificationUri(data.verification_uri);
	const interval = typeof data.interval === "number" && data.interval > 0 ? data.interval : undefined;
	const expiresIn = data.expires_in;

	if (
		typeof deviceCode !== "string" ||
		!deviceCode ||
		typeof userCode !== "string" ||
		!userCode ||
		!verificationUri ||
		typeof expiresIn !== "number" ||
		expiresIn <= 0
	) {
		throw new Error("xAI device authorization response had an invalid schema");
	}

	// Only trust the prefilled URI when it points at xAI and does not leak the
	// opaque device code into a browser-visible URL.
	const verificationUriComplete = validateVerificationUri(data.verification_uri_complete);
	const safeVerificationUriComplete =
		verificationUriComplete && !verificationUriComplete.includes(deviceCode) ? verificationUriComplete : undefined;

	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete: safeVerificationUriComplete,
		intervalSeconds: interval ?? DEFAULT_POLL_INTERVAL_SECONDS,
		expiresInSeconds: expiresIn,
	};
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const timeout = setTimeout(resolve, ms);

		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

function credentialsFromTokenResponse(data: TokenResponse, previousRefreshToken?: string): OAuthCredentials {
	const refresh = data.refresh_token || previousRefreshToken;
	if (typeof data.access_token !== "string" || !data.access_token || typeof refresh !== "string" || !refresh) {
		throw new Error("xAI token response is missing access or refresh token");
	}

	const expiresIn =
		typeof data.expires_in === "number" && data.expires_in > 0
			? data.expires_in
			: DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;

	// The skew must never consume the whole lifetime: a token issued with
	// expires_in <= 300s would otherwise be born expired and refresh on first use.
	const lifetimeMs = expiresIn * 1000;
	const skewMs = Math.min(TOKEN_EXPIRY_SKEW_MS, lifetimeMs / 2);

	return {
		refresh,
		access: data.access_token,
		expires: Date.now() + lifetimeMs - skewMs,
	};
}

async function pollForTokens(device: DeviceAuthorization, signal?: AbortSignal): Promise<OAuthCredentials> {
	const deadline = Date.now() + Math.min(device.expiresInSeconds * 1000, MAX_LOGIN_DURATION_MS);
	let intervalMs = Math.max(1000, device.intervalSeconds * 1000);

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		await abortableSleep(Math.min(intervalMs, deadline - Date.now()), signal);

		const response = await postForm(
			TOKEN_URL,
			{
				grant_type: DEVICE_GRANT_TYPE,
				device_code: device.deviceCode,
				client_id: CLIENT_ID,
			},
			signal,
		);

		if (response.ok) {
			const data = (await readJson(response, "xAI device token response")) as TokenResponse;
			return credentialsFromTokenResponse(data);
		}

		if (response.status >= 500 || response.status === 408) {
			throw new Error(`xAI device token request failed with status ${response.status}`);
		}

		const data = (await readJson(response, "xAI device token response")) as TokenResponse;
		const error = typeof data.error === "string" ? data.error : undefined;

		if (error === "authorization_pending") {
			continue;
		}

		if (error === "slow_down") {
			const requestedIntervalMs = typeof data.interval === "number" && data.interval > 0 ? data.interval * 1000 : 0;
			intervalMs = Math.max(intervalMs + SLOW_DOWN_INCREMENT_SECONDS * 1000, requestedIntervalMs);
			continue;
		}

		if (error === "access_denied" || error === "authorization_denied") {
			throw new Error("xAI device authorization was denied");
		}

		if (error === "expired_token") {
			break;
		}

		const description = typeof data.error_description === "string" ? `: ${data.error_description}` : "";
		throw new Error(`xAI device authorization failed${error ? ` (${error}${description})` : ""}`);
	}

	throw new Error("xAI device authorization expired; run the login again");
}

/**
 * Login with xAI Grok OAuth (device authorization grant).
 *
 * @param options.onAuth - Called with the verification URL and the user code
 * @param options.onProgress - Optional progress messages
 * @param options.signal - Optional AbortSignal for cancellation
 */
export async function loginGrok(options: {
	onAuth: (url: string, instructions?: string) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const device = await startDeviceFlow(options.signal);
	options.onAuth(device.verificationUriComplete ?? device.verificationUri, `Enter code: ${device.userCode}`);
	options.onProgress?.("Waiting for approval in the browser...");
	return pollForTokens(device, options.signal);
}

/**
 * Refresh an xAI Grok OAuth access token.
 */
export async function refreshGrokToken(refreshToken: string): Promise<OAuthCredentials> {
	if (!refreshToken) {
		throw new Error("xAI token refresh requires a refresh token; run the login again");
	}

	const response = await postForm(TOKEN_URL, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: CLIENT_ID,
	});

	if (!response.ok) {
		throw new Error(`xAI token refresh failed with status ${response.status}`);
	}

	const data = (await readJson(response, "xAI token refresh response")) as TokenResponse;
	return credentialsFromTokenResponse(data, refreshToken);
}

export const grokOAuthProvider: OAuthProviderInterface = {
	id: "grok",
	name: "xAI Grok (SuperGrok / Premium+ subscription)",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGrok({
			onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshGrokToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
