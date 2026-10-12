/**
 * HTTP clients for the two places usage can come from:
 *
 *  1. claude.ai, authenticated with the browser session cookie the user pastes in (default).
 *  2. api.anthropic.com's OAuth usage endpoint, authenticated with the local Claude Code login
 *     (optional fallback for networks where Cloudflare challenges claude.ai requests).
 *
 * Both return the same payload shape, which `parseUsage` normalises.
 */

import { mergeSetCookies } from "./credentials.js";

export type ErrorKind =
	| "not_configured"
	| "auth"
	| "cloudflare"
	| "rate_limit"
	| "network"
	| "server"
	| "parse"
	| "no_org";

export class UsageError extends Error {
	constructor(
		readonly kind: ErrorKind,
		message: string,
		readonly status?: number,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "UsageError";
	}
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CLAUDE_AI = "https://claude.ai";
const TIMEOUT_MS = 15_000;

export function defaultUserAgent(platform: string = process.platform): string {
	const os = platform === "win32" ? "Windows NT 10.0; Win64; x64" : "Macintosh; Intel Mac OS X 10_15_7";
	return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36`;
}

export type Organization = {
	uuid: string;
	name: string;
	capabilities: string[];
	rateLimitTier?: string;
};

export type ClaudeWebClientOptions = {
	cookie: string;
	userAgent?: string;
	fetch?: FetchLike;
	/** Called when claude.ai rotates cookies, so the fresh jar can be persisted. */
	onCookieUpdate?: (cookie: string) => void;
};

export class ClaudeWebClient {
	#cookie: string;
	readonly #userAgent: string;
	readonly #fetch: FetchLike;
	readonly #onCookieUpdate?: (cookie: string) => void;

	constructor(options: ClaudeWebClientOptions) {
		this.#cookie = options.cookie;
		this.#userAgent = options.userAgent || defaultUserAgent();
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#onCookieUpdate = options.onCookieUpdate;
	}

	get cookie(): string {
		return this.#cookie;
	}

	async listOrganizations(): Promise<Organization[]> {
		const json = await this.#get("/api/organizations");
		if (!Array.isArray(json)) throw new UsageError("parse", "Unexpected response from claude.ai (organizations)");
		return json
			.filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null && typeof o.uuid === "string")
			.map((o) => ({
				uuid: o.uuid as string,
				name: typeof o.name === "string" ? o.name : "",
				capabilities: Array.isArray(o.capabilities) ? o.capabilities.filter((c): c is string => typeof c === "string") : [],
				rateLimitTier: typeof o.rate_limit_tier === "string" ? o.rate_limit_tier : undefined,
			}));
	}

	async getUsage(orgId: string): Promise<unknown> {
		return this.#get(`/api/organizations/${encodeURIComponent(orgId)}/usage`);
	}

	async #get(path: string): Promise<unknown> {
		let res: Response;
		try {
			res = await this.#fetch(`${CLAUDE_AI}${path}`, {
				method: "GET",
				headers: {
					accept: "application/json, text/plain, */*",
					"accept-language": "en-US,en;q=0.9",
					"anthropic-client-platform": "web_claude_ai",
					"cache-control": "no-cache",
					cookie: this.#cookie,
					referer: `${CLAUDE_AI}/settings/usage`,
					"user-agent": this.#userAgent,
				},
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (err) {
			throw networkError(err);
		}

		this.#absorbCookies(res);
		const body = await res.text().catch(() => "");

		if (res.ok) {
			try {
				return JSON.parse(body);
			} catch {
				if (looksLikeChallenge(res, body)) throw cloudflareError(res.status);
				throw new UsageError("parse", "claude.ai returned something that isn't JSON", res.status);
			}
		}
		throw classifyHttpError(res, body);
	}

	#absorbCookies(res: Response): void {
		const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
		if (setCookies.length === 0) return;
		const merged = mergeSetCookies(this.#cookie, setCookies);
		if (merged.changed) {
			this.#cookie = merged.header;
			this.#onCookieUpdate?.(merged.header);
		}
	}
}

export function classifyHttpError(res: Response, body: string): UsageError {
	const status = res.status;
	if (looksLikeChallenge(res, body)) return cloudflareError(status);
	if (status === 401 || status === 403) {
		return new UsageError("auth", "claude.ai rejected the session — your cookie has probably expired. Paste a fresh one.", status);
	}
	if (status === 404) {
		return new UsageError("no_org", "claude.ai couldn't find that organization.", status);
	}
	if (status === 429) {
		const retryAfter = Number(res.headers.get("retry-after"));
		return new UsageError(
			"rate_limit",
			"claude.ai is rate limiting usage checks. Backing off for a bit.",
			status,
			Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
		);
	}
	if (status >= 500) {
		return new UsageError("server", `claude.ai is having trouble (HTTP ${status}). Will retry.`, status);
	}
	return new UsageError("server", `Unexpected response from claude.ai (HTTP ${status}).`, status);
}

function looksLikeChallenge(res: Response, body: string): boolean {
	if ((res.headers.get("cf-mitigated") ?? "").toLowerCase().includes("challenge")) return true;
	const head = body.slice(0, 64 * 1024);
	return /<html/i.test(head) && /just a moment|challenge-platform|cf-chl|cf_chl/i.test(head);
}

function cloudflareError(status: number): UsageError {
	return new UsageError(
		"cloudflare",
		"Cloudflare blocked the request. Paste a fresh “Copy as cURL” (it carries cf_clearance + your browser's User-Agent), turn off any VPN, or enable the Claude Code fallback.",
		status,
	);
}

function networkError(err: unknown): UsageError {
	const name = err instanceof Error ? err.name : "";
	if (name === "TimeoutError" || name === "AbortError") {
		return new UsageError("network", "claude.ai took too long to respond.");
	}
	return new UsageError("network", "Can't reach claude.ai — check your internet connection.");
}

/* ------------------------------------------------------------------------------------------------
 * Organization + plan helpers
 * ---------------------------------------------------------------------------------------------- */

export function chooseOrganization(orgs: readonly Organization[], preferred?: string): Organization | undefined {
	if (preferred) {
		const match = orgs.find((o) => o.uuid.toLowerCase() === preferred.toLowerCase());
		if (match) return match;
	}
	const caps = (o: Organization) => new Set(o.capabilities.map((c) => c.toLowerCase()));
	return (
		orgs.find((o) => caps(o).has("claude_max")) ??
		orgs.find((o) => caps(o).has("claude_pro")) ??
		orgs.find((o) => caps(o).has("chat")) ??
		orgs.find((o) => !(caps(o).size === 1 && caps(o).has("api"))) ??
		orgs[0]
	);
}

export function planName(input: { rateLimitTier?: string; capabilities?: readonly string[]; subscriptionType?: string }): string | undefined {
	const tier = (input.rateLimitTier ?? "").toLowerCase();
	const multiplier = tier.match(/max_(\d+)x/)?.[1];
	if (multiplier) return `Max ${multiplier}x`;
	const sub = (input.subscriptionType ?? "").toLowerCase();
	const caps = new Set((input.capabilities ?? []).map((c) => c.toLowerCase()));
	if (tier.includes("max") || sub === "max" || caps.has("claude_max")) return "Max";
	if (tier.includes("enterprise") || sub === "enterprise") return "Enterprise";
	if (tier.includes("team") || sub === "team") return "Team";
	if (tier.includes("pro") || sub === "pro" || caps.has("claude_pro")) return "Pro";
	if (caps.has("chat") || sub === "free") return "Free";
	return undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Claude Code OAuth endpoint
 * ---------------------------------------------------------------------------------------------- */

export async function fetchOAuthUsage(accessToken: string, fetchImpl: FetchLike = (i, o) => fetch(i, o)): Promise<unknown> {
	let res: Response;
	try {
		res = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"user-agent": "claude-usage-streamdeck",
			},
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw networkError(err);
	}
	const body = await res.text().catch(() => "");
	if (res.ok) {
		try {
			return JSON.parse(body);
		} catch {
			throw new UsageError("parse", "Anthropic returned something that isn't JSON", res.status);
		}
	}
	if (res.status === 401) {
		throw new UsageError("auth", "Your Claude Code login has expired. Run `claude` once to refresh it.", 401);
	}
	if (res.status === 403) {
		throw new UsageError("auth", "This Claude Code login can't read usage. Run /login in Claude Code, then try again.", 403);
	}
	if (res.status === 429) {
		throw new UsageError("rate_limit", "Anthropic is rate limiting usage checks. Backing off for a bit.", 429);
	}
	throw new UsageError("server", `Anthropic usage endpoint returned HTTP ${res.status}.`, res.status);
}
