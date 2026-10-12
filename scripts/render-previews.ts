/**
 * Renders every key style at a range of usage levels to PNG, for eyeballing designs and for the
 * README. Usage: npm run previews [-- <outDir>]
 *
 * Fonts: Stream Deck renders with Helvetica Neue (macOS) or Segoe UI (Windows). Liberation Sans is
 * metric-compatible with Helvetica/Arial, so previews use it when available.
 */

import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_PREFS, type GaugeStyle, type Prefs, type ThemeName } from "../src/core/settings.js";
import type { LimitWindow } from "../src/core/usage.js";
import { type Frame, type MessageKind, renderGauge, renderMessage, renderOverview, renderStrip } from "../src/render/keys.js";

const out = process.argv[2] ?? "docs/images/keys";
mkdirSync(out, { recursive: true });

const NOW = Date.parse("2026-10-12T15:00:00Z");
const H = 3_600_000;

export function sampleWindows(session: number, weekly: number, extra?: number): LimitWindow[] {
	const w: LimitWindow[] = [
		{ id: "five_hour", label: "Session (5h)", short: "SESSION", percent: session, resetsAt: NOW + 2 * H + 14 * 60_000, windowMs: 5 * H },
		{ id: "seven_day", label: "Weekly", short: "WEEKLY", percent: weekly, resetsAt: NOW + 3 * 24 * H + 4 * H, windowMs: 7 * 24 * H },
	];
	if (extra !== undefined) {
		w.push({ id: "model:fable", label: "Weekly · Fable", short: "FABLE", percent: extra, resetsAt: NOW + 3 * 24 * H + 4 * H, windowMs: 7 * 24 * H });
	}
	return w;
}

export function png(svg: string, width: number): Buffer {
	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: width },
		font: { loadSystemFonts: true, sansSerifFamily: "Liberation Sans", defaultFontFamily: "Liberation Sans" },
	});
	return resvg.render().asPng();
}

function frame(theme: ThemeName = "heat", extra: Partial<Frame> = {}): Frame {
	const prefs: Prefs = { ...DEFAULT_PREFS, theme };
	return { now: NOW, prefs, showPace: true, ...extra };
}

const write = (name: string, svg: string, width = 144) => writeFileSync(join(out, `${name}.png`), png(svg, width));

const levels = [8, 37, 63, 86, 100];
const styles: GaugeStyle[] = ["ring", "liquid", "number", "countdown"];

for (const style of styles) {
	for (const pct of levels) {
		const [session] = sampleWindows(pct, 20);
		write(`${style}-${pct}`, renderGauge(style, session, frame()));
	}
}
for (const theme of ["heat", "claude", "ocean", "mono"] as ThemeName[]) {
	for (const pct of [20, 55, 85]) {
		write(`theme-${theme}-${pct}`, renderGauge("ring", sampleWindows(pct, 20)[0], frame(theme)));
	}
}
write("bars-2", renderOverview("bars", sampleWindows(46, 71), frame()));
write("bars-3", renderOverview("bars", sampleWindows(46, 71, 12), frame()));
write("bars-4", renderOverview("bars", [...sampleWindows(46, 71, 12), { ...sampleWindows(90, 0)[0], id: "x", short: "SONNET" }], frame()));
write("dual", renderOverview("dual", sampleWindows(46, 71), frame()));
write("dual-hot", renderOverview("dual", sampleWindows(93, 64), frame()));
write("strip", renderStrip(sampleWindows(46, 71, 12), "five_hour", frame()), 400);
write("strip-weekly", renderStrip(sampleWindows(46, 88, 12), "seven_day", frame()), 400);
write("ring-busy", renderGauge("ring", sampleWindows(46, 20)[0], frame("heat", { spin: 40 })));
write("liquid-busy", renderGauge("liquid", sampleWindows(46, 20)[0], frame("heat", { spin: 40 })));
write("ring-stale", renderGauge("ring", sampleWindows(46, 20)[0], frame("heat", { badge: "warn" })));
write("ring-pulse", renderGauge("ring", sampleWindows(92, 20)[0], frame("heat", { pulse: 1 })));
for (const kind of ["setup", "loading", "auth", "cloudflare", "network", "rate_limit", "error"] as MessageKind[]) {
	write(`msg-${kind}`, renderMessage(kind, frame("heat", { spin: 30 })));
}
write("msg-strip-setup", renderMessage("setup", frame(), { w: 200, h: 100 }), 400);

console.log(`Previews written to ${out}`);
