/**
 * Colour themes. Each theme maps usage to colour through four stops placed at
 * 0%, the warning threshold, the critical threshold and 100%, blended smoothly in between —
 * so a key gradually warms up as you burn through a limit.
 */

import type { Prefs, ThemeName } from "../core/settings.js";

type Theme = {
	label: string;
	/** ok → warning → critical → maxed out */
	stops: readonly [string, string, string, string];
	/** Accent used for chrome (spinners, setup screens). */
	accent: string;
};

export const THEMES: Record<ThemeName, Theme> = {
	heat: { label: "Heat", stops: ["#34D399", "#FACC15", "#FB923C", "#F43F5E"], accent: "#D97757" },
	claude: { label: "Claude", stops: ["#EDE6DA", "#EBA27A", "#D97757", "#B83A26"], accent: "#D97757" },
	ocean: { label: "Ocean", stops: ["#38BDF8", "#818CF8", "#C084FC", "#F472B6"], accent: "#38BDF8" },
	mono: { label: "Mono", stops: ["#F4F4F5", "#F4F4F5", "#FF453A", "#FF453A"], accent: "#F4F4F5" },
};

export const BG = "#0B0B0E";
export const TRACK = "#FFFFFF";
export const TEXT = "#FFFFFF";
export const MUTED = "#A1A1AA";
export const SOFT = "#D4D4D8";

export function usageColor(percent: number, prefs: Pick<Prefs, "theme" | "warnAt" | "critAt">): string {
	const theme = THEMES[prefs.theme] ?? THEMES.heat;
	const [ok, warn, crit, max] = theme.stops;
	const p = Math.max(0, Math.min(100, percent));

	if (prefs.theme === "mono") {
		return p >= prefs.critAt ? crit : ok;
	}
	if (p <= prefs.warnAt) return mix(ok, warn, p / prefs.warnAt);
	if (p <= prefs.critAt) return mix(warn, crit, (p - prefs.warnAt) / (prefs.critAt - prefs.warnAt));
	return mix(crit, max, (p - prefs.critAt) / Math.max(1, 100 - prefs.critAt));
}

export type Severity = "ok" | "warn" | "crit" | "max";

export function severity(percent: number, prefs: Pick<Prefs, "warnAt" | "critAt">): Severity {
	if (percent >= 100) return "max";
	if (percent >= prefs.critAt) return "crit";
	if (percent >= prefs.warnAt) return "warn";
	return "ok";
}

export function accent(prefs: Pick<Prefs, "theme">): string {
	return (THEMES[prefs.theme] ?? THEMES.heat).accent;
}

/* ------------------------------------------------------------------------------------------------ */

export function mix(a: string, b: string, t: number): string {
	const ca = hex(a);
	const cb = hex(b);
	const k = Math.max(0, Math.min(1, t));
	return rgbHex(ca.map((v, i) => v + (cb[i] - v) * k) as [number, number, number]);
}

export function shade(color: string, amount: number): string {
	return amount >= 0 ? mix(color, "#FFFFFF", amount) : mix(color, "#000000", -amount);
}

function hex(color: string): [number, number, number] {
	const h = color.replace("#", "");
	const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbHex([r, g, b]: [number, number, number]): string {
	return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
