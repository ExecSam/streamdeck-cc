/**
 * Normalises the claude.ai / Claude Code usage payload into a list of limit windows.
 *
 * The endpoint is undocumented and has changed shape over time, so parsing is deliberately
 * forgiving: known keys get friendly names, unknown `five_hour*` / `seven_day*` windows still show
 * up, and model-scoped weekly caps are read from the newer `limits` array.
 *
 * Example payload:
 * {
 *   "five_hour":  { "utilization": 11.0, "resets_at": "2026-07-03T00:30:00.282668+00:00" },
 *   "seven_day":  { "utilization": 9.0,  "resets_at": "2026-07-08T09:00:00.282694+00:00" },
 *   "seven_day_sonnet": null,
 *   "limits": [{ "kind": "weekly_scoped", "percent": 5, "resets_at": "…",
 *                "scope": { "model": { "display_name": "Fable" } } }],
 *   "extra_usage": { "is_enabled": true, "monthly_limit": 2000, "used_credits": 500 }
 * }
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type LimitWindow = {
	/** Stable id used in settings, e.g. `five_hour`, `seven_day`, `model:fable`. */
	id: string;
	/** Human label, e.g. "Session (5h)". */
	label: string;
	/** Short upper-case label that fits on a key, e.g. "SESSION". */
	short: string;
	/** Percentage used, 0–100 (can exceed 100 when over the limit). */
	percent: number;
	/** Epoch ms when the window resets, if known. */
	resetsAt: number | null;
	/** Length of the window in ms, if known. */
	windowMs: number | null;
};

export type ExtraUsage = {
	enabled: boolean;
	/** Amounts are in minor units (cents). */
	usedMinor: number;
	limitMinor: number;
	currency: string;
};

export type UsageSnapshot = {
	windows: LimitWindow[];
	extra: ExtraUsage | null;
	fetchedAt: number;
	source: "web" | "claude-code";
};

type KnownWindow = { label: string; short: string; windowMs: number };

const KNOWN: Record<string, KnownWindow> = {
	five_hour: { label: "Session (5h)", short: "SESSION", windowMs: 5 * HOUR },
	seven_day: { label: "Weekly (all models)", short: "WEEKLY", windowMs: 7 * DAY },
	seven_day_opus: { label: "Weekly · Opus", short: "OPUS", windowMs: 7 * DAY },
	seven_day_sonnet: { label: "Weekly · Sonnet", short: "SONNET", windowMs: 7 * DAY },
	seven_day_oauth_apps: { label: "Weekly · OAuth apps", short: "APPS", windowMs: 7 * DAY },
	seven_day_routines: { label: "Routines", short: "ROUTINE", windowMs: 7 * DAY },
	seven_day_cowork: { label: "Cowork", short: "COWORK", windowMs: 7 * DAY },
};

/** Windows that are reported but not useful to show (Claude Design is folded into the weekly cap). */
const IGNORED = new Set(["seven_day_omelette"]);

const ORDER = ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"];

export function parseUsage(json: unknown, source: UsageSnapshot["source"], now = Date.now()): UsageSnapshot {
	if (!isObject(json)) {
		throw new Error("Usage response was not a JSON object");
	}

	const windows: LimitWindow[] = [];
	const seen = new Set<string>();

	for (const [key, value] of Object.entries(json)) {
		if (IGNORED.has(key) || !isObject(value)) continue;
		if (!/^(five_hour|seven_day)/.test(key)) continue;
		const percent = num(value.utilization);
		if (percent === null) continue;

		const known = KNOWN[key] ?? guessWindow(key);
		windows.push({
			id: key,
			label: known.label,
			short: known.short,
			percent,
			resetsAt: parseDate(value.resets_at),
			windowMs: known.windowMs,
		});
		seen.add(known.short);
	}

	// Newer payloads describe limits in an array. Use it for model-scoped weekly caps, and as a fallback
	// for session/weekly when the flat fields are missing.
	if (Array.isArray(json.limits)) {
		for (const entry of json.limits) {
			if (!isObject(entry)) continue;
			const percent = num(entry.percent) ?? num(entry.utilization);
			if (percent === null) continue;
			const resetsAt = parseDate(entry.resets_at);

			if (entry.kind === "session" && !windows.some((w) => w.id === "five_hour")) {
				windows.push({ id: "five_hour", ...KNOWN.five_hour, percent, resetsAt });
			} else if (entry.kind === "weekly_all" && !windows.some((w) => w.id === "seven_day")) {
				windows.push({ id: "seven_day", ...KNOWN.seven_day, percent, resetsAt });
			} else if (entry.kind === "weekly_scoped") {
				const scope = isObject(entry.scope) ? entry.scope : undefined;
				const model = scope && isObject(scope.model) ? scope.model : undefined;
				const name = typeof model?.display_name === "string" ? model.display_name.trim() : "";
				if (!name) continue;
				const short = name.toUpperCase().slice(0, 7);
				if (seen.has(short)) continue;
				seen.add(short);
				windows.push({
					id: `model:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
					label: `Weekly · ${name}`,
					short,
					percent,
					resetsAt,
					windowMs: 7 * DAY,
				});
			}
		}
	}

	windows.sort((a, b) => rank(a.id) - rank(b.id));

	return { windows, extra: parseExtra(json.extra_usage), fetchedAt: now, source };
}

function rank(id: string): number {
	const idx = ORDER.indexOf(id);
	if (idx >= 0) return idx;
	return id.startsWith("model:") ? ORDER.length : ORDER.length + 1;
}

function guessWindow(key: string): KnownWindow {
	const isSession = key.startsWith("five_hour");
	const rest = key.replace(/^(five_hour|seven_day)_?/, "").replace(/_/g, " ").trim();
	const pretty = rest.replace(/\b\w/g, (c) => c.toUpperCase());
	return {
		label: isSession ? `Session · ${pretty || "5h"}` : `Weekly · ${pretty || "all"}`,
		short: (rest || (isSession ? "session" : "weekly")).toUpperCase().slice(0, 7),
		windowMs: isSession ? 5 * HOUR : 7 * DAY,
	};
}

function parseExtra(value: unknown): ExtraUsage | null {
	if (!isObject(value)) return null;
	const limit = num(value.monthly_limit) ?? num(value.monthly_credit_limit);
	const used = num(value.used_credits);
	if (limit === null && used === null) return null;
	return {
		enabled: value.is_enabled !== false,
		usedMinor: used ?? 0,
		limitMinor: limit ?? 0,
		currency: typeof value.currency === "string" ? value.currency : "USD",
	};
}

/* ------------------------------------------------------------------------------------------------
 * Derived numbers: time elapsed in the window, pace and projections
 * ---------------------------------------------------------------------------------------------- */

/** Fraction (0–1) of the window that has elapsed, or null if unknown. */
export function elapsedFraction(w: LimitWindow, now = Date.now()): number | null {
	if (w.resetsAt === null || !w.windowMs) return null;
	const remaining = w.resetsAt - now;
	return clamp(1 - remaining / w.windowMs, 0, 1);
}

export type Projection = {
	/** Usage percent minus time-elapsed percent. Positive = burning faster than sustainable. */
	paceDelta: number;
	/** How many times faster than "even" the window is being used (1 = exactly on pace). */
	paceRatio: number;
	/** Epoch ms when 100% will be reached at the current rate, if that happens before reset. */
	limitAt: number | null;
};

export function project(w: LimitWindow, now = Date.now()): Projection | null {
	const elapsed = elapsedFraction(w, now);
	if (elapsed === null || w.resetsAt === null || !w.windowMs) return null;
	const paceDelta = w.percent - elapsed * 100;
	const elapsedMs = elapsed * w.windowMs;
	// Too early in the window to extrapolate sensibly.
	if (elapsedMs < Math.min(10 * 60_000, w.windowMs * 0.03) || w.percent <= 0) {
		return { paceDelta, paceRatio: elapsed > 0 ? w.percent / 100 / elapsed : 0, limitAt: null };
	}
	const ratePerMs = w.percent / elapsedMs;
	const limitAt = w.percent >= 100 ? now : now + (100 - w.percent) / ratePerMs;
	return {
		paceDelta,
		paceRatio: w.percent / 100 / elapsed,
		limitAt: limitAt < w.resetsAt ? limitAt : null,
	};
}

/** The window closest to its limit — what "auto" shows. */
export function mostConstrained(windows: readonly LimitWindow[]): LimitWindow | undefined {
	let best: LimitWindow | undefined;
	for (const w of windows) {
		if (!best || w.percent > best.percent) best = w;
	}
	return best;
}

export function pickWindow(snapshot: UsageSnapshot | null, metric: string | undefined): LimitWindow | undefined {
	if (!snapshot || snapshot.windows.length === 0) return undefined;
	if (!metric || metric === "auto") return mostConstrained(snapshot.windows);
	return snapshot.windows.find((w) => w.id === metric) ?? snapshot.windows[0];
}

/* ------------------------------------------------------------------------------------------------ */

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return null;
}

function parseDate(v: unknown): number | null {
	if (typeof v !== "string" || !v) return null;
	// Python-style timestamps carry microseconds ("…00.282668+00:00"); trim to milliseconds.
	const ms = Date.parse(v.replace(/(\.\d{3})\d+/, "$1"));
	return Number.isFinite(ms) ? ms : null;
}

export function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}
