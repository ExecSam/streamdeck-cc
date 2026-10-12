/**
 * Settings shapes shared between the plugin, the renderers and the property inspector.
 *
 * Global settings (credentials + appearance) are owned exclusively by the plugin: the property
 * inspector asks for changes through `sendToPlugin` messages and the plugin persists them. Per-key
 * settings are ordinary Stream Deck action settings written by the property inspector.
 */

export type ThemeName = "heat" | "claude" | "ocean" | "mono";
export type CredentialSource = "cookie" | "claude-code";

/** Appearance and behaviour preferences that apply to every key. */
export type Prefs = {
	theme: ThemeName;
	/** Percentage at which a limit turns "warning" coloured. */
	warnAt: number;
	/** Percentage at which a limit turns "critical" coloured (and pulses). */
	critAt: number;
	/** Pulse the glow when a limit is at or above `critAt`. */
	pulse: boolean;
	/** Animate refreshes and value changes. */
	animate: boolean;
	/** Seconds between automatic refreshes. */
	pollSeconds: number;
	/** When the cookie is blocked by Cloudflare, try the local Claude Code login instead. */
	claudeCodeFallback: boolean;
};

export const DEFAULT_PREFS: Prefs = {
	theme: "heat",
	warnAt: 50,
	critAt: 80,
	pulse: true,
	animate: true,
	pollSeconds: 60,
	claudeCodeFallback: false,
};

export const POLL_CHOICES = [30, 60, 120, 300, 600] as const;

/** Persisted global settings. Index signature keeps it assignable to the SDK's JsonObject. */
export type GlobalSettings = Partial<Prefs> & {
	[key: string]: string | number | boolean | null | undefined;
	source?: CredentialSource;
	/** Raw `Cookie` header value for claude.ai (or `sessionKey=...`). */
	cookie?: string;
	/** User-Agent captured from the browser (helps with Cloudflare when cf_clearance is present). */
	userAgent?: string;
	orgId?: string;
	orgName?: string;
	plan?: string;
};

export function resolvePrefs(settings: GlobalSettings | undefined): Prefs {
	const s = settings ?? {};
	const pick = <K extends keyof Prefs>(key: K, valid: (v: unknown) => boolean): Prefs[K] =>
		valid(s[key]) ? (s[key] as Prefs[K]) : DEFAULT_PREFS[key];

	const isPct = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 100;
	const prefs: Prefs = {
		theme: pick("theme", (v) => v === "heat" || v === "claude" || v === "ocean" || v === "mono"),
		warnAt: pick("warnAt", isPct),
		critAt: pick("critAt", isPct),
		pulse: pick("pulse", (v) => typeof v === "boolean"),
		animate: pick("animate", (v) => typeof v === "boolean"),
		pollSeconds: pick("pollSeconds", (v) => typeof v === "number" && v >= 30 && v <= 3600),
		claudeCodeFallback: pick("claudeCodeFallback", (v) => typeof v === "boolean"),
	};
	if (prefs.critAt <= prefs.warnAt) {
		prefs.critAt = Math.min(100, prefs.warnAt + 10);
	}
	return prefs;
}

/* ------------------------------------------------------------------------------------------------
 * Per-key settings
 * ---------------------------------------------------------------------------------------------- */

export type PressAction = "refresh" | "cycle" | "style" | "open" | "none";

export type GaugeStyle = "ring" | "liquid" | "number" | "countdown";
export type OverviewStyle = "bars" | "dual";

/** `auto` shows whichever limit is closest to running out. */
export type MetricChoice = "auto" | string;

export type GaugeSettings = {
	[key: string]: string | number | boolean | null | undefined;
	metric?: MetricChoice;
	style?: GaugeStyle;
	press?: PressAction;
	longPress?: PressAction;
	showPace?: boolean;
};

export type OverviewSettings = {
	[key: string]: string | number | boolean | null | undefined;
	style?: OverviewStyle;
	press?: PressAction;
	longPress?: PressAction;
	showPace?: boolean;
	/** Encoder only: which limit the dial is focused on. */
	focus?: string;
};

export const GAUGE_STYLES: readonly GaugeStyle[] = ["ring", "liquid", "number", "countdown"];
export const OVERVIEW_STYLES: readonly OverviewStyle[] = ["bars", "dual"];

export const USAGE_PAGE_URL = "https://claude.ai/settings/usage";

/** Union of every per-key setting, used where gauge and overview keys are handled together. */
export type KeySettings = {
	[key: string]: string | number | boolean | null | undefined;
	metric?: MetricChoice;
	style?: GaugeStyle | OverviewStyle;
	press?: PressAction;
	longPress?: PressAction;
	showPace?: boolean;
	focus?: string;
};
