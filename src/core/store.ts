/**
 * The single source of truth for usage data. Owns the credentials, polls on a schedule while any key
 * is visible, backs off on errors, refreshes right after a window resets, and notifies subscribers
 * (keys, dials, the property inspector) whenever anything changes.
 *
 * It has no Stream Deck dependencies so it can be unit tested with a fake fetch and fake storage.
 */

import { type ClaudeCodeToken, readClaudeCodeToken } from "./claude-code.js";
import { ClaudeWebClient, chooseOrganization, type FetchLike, fetchOAuthUsage, planName, UsageError } from "./client.js";
import { parseCredentialInput } from "./credentials.js";
import { type GlobalSettings, type Prefs, resolvePrefs } from "./settings.js";
import { parseUsage, type UsageSnapshot } from "./usage.js";

export type StoreState = {
	/** Settings have been loaded from Stream Deck. */
	ready: boolean;
	configured: boolean;
	source: "cookie" | "claude-code";
	snapshot: UsageSnapshot | null;
	error: UsageError | null;
	fetching: boolean;
	/** True while a refresh the user asked for (key press) is in flight. */
	manual: boolean;
	lastAttempt: number | null;
	lastSuccess: number | null;
	orgName?: string;
	plan?: string;
	prefs: Prefs;
};

export type StoreDeps = {
	load: () => Promise<GlobalSettings>;
	save: (settings: GlobalSettings) => Promise<void>;
	fetch?: FetchLike;
	readClaudeCodeToken?: () => Promise<ClaudeCodeToken>;
	log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
	now?: () => number;
};

export type ConnectResult = { ok: boolean; message: string };

const MIN_MANUAL_GAP_MS = 4_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export class UsageStore {
	#settings: GlobalSettings = {};
	#snapshot: UsageSnapshot | null = null;
	#error: UsageError | null = null;
	#inflight: Promise<boolean> | null = null;
	#manual = false;
	#lastAttempt: number | null = null;
	#lastSuccess: number | null = null;
	#failures = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#views = 0;
	#ready = false;
	/** Bumped whenever the account changes, so in-flight refreshes for the old account are dropped. */
	#generation = 0;
	readonly #listeners = new Set<() => void>();
	readonly #deps: Required<Omit<StoreDeps, "fetch">> & { fetch?: FetchLike };

	constructor(deps: StoreDeps) {
		this.#deps = {
			readClaudeCodeToken,
			log: () => {},
			now: () => Date.now(),
			...deps,
		};
	}

	async init(): Promise<void> {
		this.#settings = (await this.#deps.load()) ?? {};
		this.#ready = true;
		this.#emit();
		if (this.#views > 0) {
			if (this.#isStale()) void this.refresh();
			else this.#schedule();
		}
	}

	/* -------------------------------------------------------------------------------------------- */

	get state(): StoreState {
		return {
			ready: this.#ready,
			configured: this.configured,
			source: this.#settings.source ?? "cookie",
			snapshot: this.#snapshot,
			error: this.#error,
			fetching: this.#inflight !== null,
			manual: this.#inflight !== null && this.#manual,
			lastAttempt: this.#lastAttempt,
			lastSuccess: this.#lastSuccess,
			orgName: this.#settings.orgName || undefined,
			plan: this.#settings.plan || undefined,
			prefs: this.prefs,
		};
	}

	get prefs(): Prefs {
		return resolvePrefs(this.#settings);
	}

	get settings(): Readonly<GlobalSettings> {
		return this.#settings;
	}

	get configured(): boolean {
		return this.#settings.source === "claude-code" || !!this.#settings.cookie;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (err) {
				this.#deps.log("error", `Listener failed: ${String(err)}`);
			}
		}
	}

	/* -------------------------------------------------------------------------------------------- *
	 * Visibility-driven polling
	 * -------------------------------------------------------------------------------------------- */

	/** Tell the store how many keys/dials are currently showing usage. Polling pauses at zero. */
	setViewCount(count: number): void {
		const wasHidden = this.#views === 0;
		this.#views = Math.max(0, count);
		if (this.#views === 0) {
			this.#clearTimer();
			return;
		}
		if (wasHidden && this.#ready) {
			if (this.#isStale()) void this.refresh();
			else this.#schedule();
		}
	}

	#isStale(): boolean {
		if (this.#lastAttempt === null) return true;
		return this.#deps.now() - this.#lastAttempt >= this.prefs.pollSeconds * 1000;
	}

	#clearTimer(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#schedule(): void {
		this.#clearTimer();
		if (!this.configured || this.#views === 0) return;

		const delay = this.nextDelay();
		this.#timer = setTimeout(() => void this.refresh(), delay);
		this.#timer.unref?.();
	}

	/** Milliseconds until the next automatic refresh. Exposed for tests. */
	nextDelay(): number {
		const poll = this.prefs.pollSeconds * 1000;
		const now = this.#deps.now();

		if (this.#error) {
			if (this.#error.kind === "auth" || this.#error.kind === "not_configured") return 30 * 60_000;
			if (this.#error.kind === "rate_limit") return Math.max(this.#error.retryAfterMs ?? 0, 5 * 60_000);
			return Math.min(poll * 2 ** Math.max(0, this.#failures - 1), MAX_BACKOFF_MS);
		}

		let delay = poll;
		// Refresh a few seconds after any window resets so keys drop back to 0% promptly.
		for (const w of this.#snapshot?.windows ?? []) {
			if (w.resetsAt !== null && w.resetsAt > now) {
				delay = Math.min(delay, w.resetsAt - now + 3_000);
			}
		}
		return Math.max(5_000, delay);
	}

	/* -------------------------------------------------------------------------------------------- *
	 * Fetching
	 * -------------------------------------------------------------------------------------------- */

	/** Fetches fresh usage. Concurrent calls share one request. Resolves true on success. */
	refresh(options: { manual?: boolean } = {}): Promise<boolean> {
		if (options.manual) {
			this.#manual = true;
		}
		if (this.#inflight) {
			this.#emit();
			return this.#inflight;
		}
		if (!this.configured) {
			this.#error = new UsageError("not_configured", "Not connected yet — paste your claude.ai cookie in the key's settings.");
			this.#emit();
			return Promise.resolve(false);
		}
		// Debounce key mashing: a manual refresh moments after the last one just replays the result.
		if (options.manual && this.#lastSuccess && this.#deps.now() - this.#lastSuccess < MIN_MANUAL_GAP_MS) {
			this.#manual = false;
			this.#emit();
			return Promise.resolve(true);
		}

		this.#inflight = this.#doRefresh().finally(() => {
			this.#inflight = null;
			this.#manual = false;
			this.#emit();
			this.#schedule();
		});
		this.#emit();
		return this.#inflight;
	}

	async #doRefresh(): Promise<boolean> {
		const generation = this.#generation;
		this.#lastAttempt = this.#deps.now();
		try {
			const snapshot = await this.#fetchSnapshot();
			if (generation !== this.#generation) return false;
			this.#snapshot = snapshot;
			this.#error = null;
			this.#failures = 0;
			this.#lastSuccess = this.#deps.now();
			return true;
		} catch (err) {
			if (generation !== this.#generation) return false;
			this.#error = toUsageError(err);
			this.#failures++;
			this.#deps.log("warn", `Usage refresh failed (${this.#error.kind}): ${this.#error.message}`);
			return false;
		}
	}

	async #fetchSnapshot(): Promise<UsageSnapshot> {
		if (this.#settings.source === "claude-code") {
			return this.#fetchViaClaudeCode();
		}
		try {
			return await this.#fetchViaCookie();
		} catch (err) {
			const error = toUsageError(err);
			if ((error.kind === "cloudflare" || error.kind === "network") && this.prefs.claudeCodeFallback) {
				this.#deps.log("info", `claude.ai unavailable (${error.kind}); trying the Claude Code login instead`);
				try {
					return await this.#fetchViaClaudeCode();
				} catch {
					throw error;
				}
			}
			throw error;
		}
	}

	async #fetchViaCookie(): Promise<UsageSnapshot> {
		const client = this.#webClient(this.#settings.cookie ?? "", this.#settings.userAgent);
		let orgId = this.#settings.orgId;

		if (!orgId) {
			orgId = await this.#discoverOrganization(client);
		}
		try {
			return parseUsage(await client.getUsage(orgId), "web", this.#deps.now());
		} catch (err) {
			// The remembered org may have gone away (e.g. left a team). Rediscover once.
			if (err instanceof UsageError && err.kind === "no_org") {
				orgId = await this.#discoverOrganization(client, true);
				return parseUsage(await client.getUsage(orgId), "web", this.#deps.now());
			}
			throw err;
		}
	}

	async #fetchViaClaudeCode(): Promise<UsageSnapshot> {
		const token = await this.#deps.readClaudeCodeToken();
		const json = await fetchOAuthUsage(token.accessToken, this.#deps.fetch);
		if (this.#settings.source === "claude-code") {
			const plan = planName(token);
			if (plan && plan !== this.#settings.plan) {
				this.#settings = { ...this.#settings, plan };
				void this.#persist();
			}
		}
		return parseUsage(json, "claude-code", this.#deps.now());
	}

	async #discoverOrganization(client: ClaudeWebClient, ignoreRemembered = false): Promise<string> {
		const orgs = await client.listOrganizations();
		const org = chooseOrganization(orgs, ignoreRemembered ? undefined : this.#settings.orgId);
		if (!org) throw new UsageError("no_org", "This claude.ai account doesn't belong to any organization.");
		this.#settings = { ...this.#settings, orgId: org.uuid, orgName: org.name, plan: planName(org) ?? "" };
		await this.#persist();
		return org.uuid;
	}

	#webClient(cookie: string, userAgent: string | undefined): ClaudeWebClient {
		return new ClaudeWebClient({
			cookie,
			userAgent,
			fetch: this.#deps.fetch,
			onCookieUpdate: (fresh) => {
				// Only persist rotations of the cookie we're actually using.
				if (this.#settings.cookie === cookie) {
					this.#settings = { ...this.#settings, cookie: fresh };
					void this.#persist();
				}
			},
		});
	}

	/* -------------------------------------------------------------------------------------------- *
	 * Account management (driven by the property inspector)
	 * -------------------------------------------------------------------------------------------- */

	/** Validates pasted browser credentials against claude.ai and stores them if they work. */
	async connect(raw: string): Promise<ConnectResult> {
		const parsed = parseCredentialInput(raw);
		if (!parsed.ok) return { ok: false, message: parsed.error };

		const { cookie, userAgent, orgId: pastedOrg } = parsed.value;
		let current = cookie;
		const client = new ClaudeWebClient({
			cookie,
			userAgent,
			fetch: this.#deps.fetch,
			onCookieUpdate: (fresh) => (current = fresh),
		});

		try {
			let orgName = "";
			let plan: string | undefined;
			let orgId = pastedOrg;
			try {
				const org = chooseOrganization(await client.listOrganizations(), pastedOrg);
				if (org) {
					orgId ??= org.uuid;
					if (org.uuid === orgId) {
						orgName = org.name;
						plan = planName(org);
					}
				}
			} catch (err) {
				// The org list is a nice-to-have when the paste already told us the org.
				if (!pastedOrg || !(err instanceof UsageError) || err.kind === "auth" || err.kind === "cloudflare") throw err;
			}
			if (!orgId) return { ok: false, message: "Signed in, but no organization was found on this account." };

			const snapshot = parseUsage(await client.getUsage(orgId), "web", this.#deps.now());

			this.#generation++;
			this.#settings = {
				...this.#settings,
				source: "cookie",
				cookie: current,
				userAgent: userAgent ?? "",
				orgId,
				orgName,
				plan: plan ?? "",
			};
			await this.#persist();
			this.#snapshot = snapshot;
			this.#error = null;
			this.#failures = 0;
			this.#lastAttempt = this.#lastSuccess = this.#deps.now();
			this.#emit();
			this.#schedule();

			const who = [orgName, plan].filter(Boolean).join(" · ");
			return { ok: true, message: who ? `Connected — ${who}` : "Connected!" };
		} catch (err) {
			const error = toUsageError(err);
			return { ok: false, message: error.message };
		}
	}

	/** Switches to reading usage through the local Claude Code login. */
	async useClaudeCode(): Promise<ConnectResult> {
		try {
			const token = await this.#deps.readClaudeCodeToken();
			const snapshot = parseUsage(await fetchOAuthUsage(token.accessToken, this.#deps.fetch), "claude-code", this.#deps.now());
			this.#generation++;
			this.#settings = { ...this.#settings, source: "claude-code", orgName: "Claude Code login", plan: planName(token) ?? "" };
			await this.#persist();
			this.#snapshot = snapshot;
			this.#error = null;
			this.#failures = 0;
			this.#lastAttempt = this.#lastSuccess = this.#deps.now();
			this.#emit();
			this.#schedule();
			return { ok: true, message: "Connected using your Claude Code login." };
		} catch (err) {
			return { ok: false, message: toUsageError(err).message };
		}
	}

	async disconnect(): Promise<void> {
		const { cookie: _c, userAgent: _u, orgId: _o, orgName: _n, plan: _p, source: _s, ...prefs } = this.#settings;
		this.#generation++;
		this.#settings = prefs;
		this.#snapshot = null;
		this.#error = null;
		this.#lastAttempt = this.#lastSuccess = null;
		this.#clearTimer();
		await this.#persist();
		this.#emit();
	}

	async updatePrefs(patch: Partial<Prefs>): Promise<void> {
		const before = this.prefs.pollSeconds;
		this.#settings = { ...this.#settings, ...patch };
		this.#settings = { ...this.#settings, ...this.prefs };
		await this.#persist();
		this.#emit();
		if (this.prefs.pollSeconds !== before) this.#schedule();
	}

	async #persist(): Promise<void> {
		try {
			await this.#deps.save({ ...this.#settings });
		} catch (err) {
			this.#deps.log("error", `Failed to save settings: ${String(err)}`);
		}
	}

	dispose(): void {
		this.#clearTimer();
		this.#listeners.clear();
	}
}

function toUsageError(err: unknown): UsageError {
	if (err instanceof UsageError) return err;
	return new UsageError("parse", err instanceof Error ? err.message : String(err));
}
