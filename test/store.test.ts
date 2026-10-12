import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyHttpError, type FetchLike } from "../src/core/client.js";
import type { GlobalSettings } from "../src/core/settings.js";
import { UsageStore } from "../src/core/store.js";

const KEY = "sk-ant-sid01-testtesttesttest";
const ORG = "0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab";
const NOW = Date.parse("2026-10-12T12:00:00Z");

const USAGE = {
	five_hour: { utilization: 42, resets_at: new Date(NOW + 2 * 3_600_000).toISOString() },
	seven_day: { utilization: 18, resets_at: new Date(NOW + 4 * 86_400_000).toISOString() },
};

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function makeStore(route: Route, initial: GlobalSettings = {}) {
	let saved: GlobalSettings = { ...initial };
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
		return route(url, init);
	};
	const store = new UsageStore({
		load: async () => saved,
		save: async (s) => {
			saved = { ...s };
		},
		fetch,
		readClaudeCodeToken: async () => ({ accessToken: "oauth-token", subscriptionType: "max", rateLimitTier: "default_claude_max_20x" }),
		now: () => NOW,
	});
	return { store, calls, saved: () => saved };
}

const happyRoutes: Route = (url) => {
	if (url.endsWith("/api/organizations")) {
		return json([
			{ uuid: "api-only-org-0000-0000-000000000000", name: "API", capabilities: ["api"] },
			{ uuid: ORG, name: "Sam's Org", capabilities: ["chat", "claude_max"], rate_limit_tier: "default_claude_max_5x" },
		]);
	}
	if (url.endsWith(`/api/organizations/${ORG}/usage`)) return json(USAGE);
	return new Response("not found", { status: 404 });
};

afterEach(() => {
	vi.useRealTimers();
});

describe("UsageStore.connect", () => {
	it("validates a pasted cookie, discovers the org and saves everything", async () => {
		const { store, saved, calls } = makeStore(happyRoutes);
		await store.init();
		const result = await store.connect(`sessionKey=${KEY}; other=1`);

		expect(result).toEqual({ ok: true, message: "Connected — Sam's Org · Max 5x" });
		expect(saved()).toMatchObject({ source: "cookie", cookie: `sessionKey=${KEY}; other=1`, orgId: ORG, plan: "Max 5x" });
		expect(store.state.snapshot?.windows.map((w) => w.percent)).toEqual([42, 18]);
		expect(store.state.error).toBeNull();
		expect(calls[0].headers.cookie).toBe(`sessionKey=${KEY}; other=1`);
		expect(calls[0].headers["user-agent"]).toMatch(/^Mozilla\/5.0/);
		store.dispose();
	});

	it("reports an expired cookie clearly and does not save it", async () => {
		const { store, saved } = makeStore(() => json({ type: "error", error: { type: "permission_error" } }, { status: 403 }));
		await store.init();
		const result = await store.connect(KEY);
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/expired/);
		expect(saved().cookie).toBeUndefined();
		store.dispose();
	});

	it("recognises a Cloudflare challenge", async () => {
		const { store } = makeStore(
			() =>
				new Response("<!DOCTYPE html><html><title>Just a moment...</title></html>", {
					status: 403,
					headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
				}),
		);
		await store.init();
		const result = await store.connect(KEY);
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/Cloudflare/);
		store.dispose();
	});

	it("rejects pastes without a session key before making any request", async () => {
		const { store, calls } = makeStore(happyRoutes);
		await store.init();
		expect((await store.connect("nope")).ok).toBe(false);
		expect(calls).toHaveLength(0);
		store.dispose();
	});
});

describe("UsageStore.refresh", () => {
	it("refreshes with stored credentials and persists rotated cookies", async () => {
		const { store, saved } = makeStore(
			(url) => {
				if (url.endsWith("/usage")) {
					const headers = new Headers({ "content-type": "application/json" });
					headers.append("set-cookie", "__cf_bm=rotated; Path=/; HttpOnly");
					return new Response(JSON.stringify(USAGE), { status: 200, headers });
				}
				return happyRoutes(url);
			},
			{ source: "cookie", cookie: `sessionKey=${KEY}; __cf_bm=old`, orgId: ORG },
		);
		await store.init();
		expect(await store.refresh()).toBe(true);
		expect(store.state.snapshot?.windows[0].percent).toBe(42);
		expect(saved().cookie).toBe(`sessionKey=${KEY}; __cf_bm=rotated`);
		store.dispose();
	});

	it("shares one request between concurrent refreshes", async () => {
		const { store, calls } = makeStore(happyRoutes, { cookie: `sessionKey=${KEY}`, orgId: ORG });
		await store.init();
		await Promise.all([store.refresh(), store.refresh(), store.refresh({ manual: true })]);
		expect(calls.filter((c) => c.url.endsWith("/usage"))).toHaveLength(1);
		store.dispose();
	});

	it("rediscovers the organization when the remembered one 404s", async () => {
		const { store, saved } = makeStore(happyRoutes, { cookie: `sessionKey=${KEY}`, orgId: "11111111-2222-3333-4444-555555555555" });
		await store.init();
		expect(await store.refresh()).toBe(true);
		expect(saved().orgId).toBe(ORG);
		store.dispose();
	});

	it("falls back to the Claude Code login when Cloudflare blocks claude.ai (if enabled)", async () => {
		const { store } = makeStore(
			(url) => {
				if (url.startsWith("https://api.anthropic.com/api/oauth/usage")) return json({ five_hour: { utilization: 77 } });
				return new Response("<html>Just a moment...</html>", { status: 403, headers: { "content-type": "text/html" } });
			},
			{ cookie: `sessionKey=${KEY}`, orgId: ORG, claudeCodeFallback: true },
		);
		await store.init();
		expect(await store.refresh()).toBe(true);
		expect(store.state.snapshot?.source).toBe("claude-code");
		expect(store.state.snapshot?.windows[0].percent).toBe(77);
		store.dispose();
	});

	it("backs off exponentially on transient errors", async () => {
		const { store } = makeStore(() => new Response("oops", { status: 502 }), { cookie: `sessionKey=${KEY}`, orgId: ORG, pollSeconds: 60 });
		await store.init();
		await store.refresh();
		expect(store.state.error?.kind).toBe("server");
		expect(store.nextDelay()).toBe(60_000);
		await store.refresh();
		expect(store.nextDelay()).toBe(120_000);
		await store.refresh();
		expect(store.nextDelay()).toBe(240_000);
		store.dispose();
	});

	it("schedules a refresh just after the next window reset", async () => {
		const soon = { five_hour: { utilization: 99, resets_at: new Date(NOW + 20_000).toISOString() } };
		const { store } = makeStore(() => json(soon), { cookie: `sessionKey=${KEY}`, orgId: ORG, pollSeconds: 300 });
		await store.init();
		await store.refresh();
		expect(store.nextDelay()).toBe(23_000);
		store.dispose();
	});

	it("only polls while something is visible", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { store, calls } = makeStore(happyRoutes, { cookie: `sessionKey=${KEY}`, orgId: ORG, pollSeconds: 60 });
		await store.init();
		store.setViewCount(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		store.setViewCount(0);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(calls).toHaveLength(1);
		store.dispose();
	});

	it("can switch to the Claude Code login", async () => {
		const { store, saved } = makeStore((url) =>
			url.includes("api.anthropic.com") ? json({ five_hour: { utilization: 5 } }) : new Response("", { status: 500 }),
		);
		await store.init();
		const result = await store.useClaudeCode();
		expect(result.ok).toBe(true);
		expect(saved()).toMatchObject({ source: "claude-code", plan: "Max 20x" });
		expect(store.configured).toBe(true);
		store.dispose();
	});

	it("disconnect forgets credentials but keeps preferences", async () => {
		const { store, saved } = makeStore(happyRoutes, { cookie: `sessionKey=${KEY}`, orgId: ORG, theme: "ocean" });
		await store.init();
		await store.disconnect();
		expect(saved()).toEqual({ theme: "ocean" });
		expect(store.configured).toBe(false);
		store.dispose();
	});
});

describe("classifyHttpError", () => {
	it("maps statuses to error kinds", () => {
		expect(classifyHttpError(new Response("", { status: 401 }), "").kind).toBe("auth");
		expect(classifyHttpError(new Response("", { status: 404 }), "").kind).toBe("no_org");
		const limited = classifyHttpError(new Response("", { status: 429, headers: { "retry-after": "120" } }), "");
		expect(limited.kind).toBe("rate_limit");
		expect(limited.retryAfterMs).toBe(120_000);
		expect(classifyHttpError(new Response("", { status: 503 }), "").kind).toBe("server");
	});
});

describe("account changes", () => {
	it("drops results of a refresh that was in flight when the user disconnected", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const { store } = makeStore(
			async (url) => {
				await gate;
				return happyRoutes(url);
			},
			{ cookie: `sessionKey=${KEY}`, orgId: ORG },
		);
		await store.init();
		const pending = store.refresh();
		await store.disconnect();
		release();
		expect(await pending).toBe(false);
		expect(store.state.snapshot).toBeNull();
		expect(store.state.configured).toBe(false);
		store.dispose();
	});
});
