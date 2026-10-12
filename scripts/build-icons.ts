/**
 * Generates the plugin's static artwork (marketplace icon, category + action list icons and default
 * key images) from SVG, so everything stays crisp and on-brand. Usage: npm run icons
 */

import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_PREFS } from "../src/core/settings.js";
import type { LimitWindow } from "../src/core/usage.js";
import { renderGauge, renderOverview, spark } from "../src/render/keys.js";
import { arc } from "../src/render/svg.js";

const IMGS = "com.execsam.claude-usage.sdPlugin/imgs";
const CORAL = "#D97757";

function write(path: string, svg: string, size: number): void {
	const file = join(IMGS, path);
	mkdirSync(dirname(file), { recursive: true });
	const png = new Resvg(svg, {
		fitTo: { mode: "width", value: size },
		font: { loadSystemFonts: true, sansSerifFamily: "Liberation Sans", defaultFontFamily: "Liberation Sans" },
	})
		.render()
		.asPng();
	writeFileSync(file, png);
}

function pair(base: string, svg: string, size: number): void {
	write(`${base}.png`, svg, size);
	write(`${base}@2x.png`, svg, size * 2);
}

/* Marketplace / plugin icon: a warm gauge with the spark at its heart. */
const marketplace = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<defs>
	<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#231815"/><stop offset="1" stop-color="#0B0B0E"/></linearGradient>
	<linearGradient id="arc" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#34D399"/><stop offset="0.55" stop-color="#FACC15"/><stop offset="1" stop-color="${CORAL}"/></linearGradient>
	<radialGradient id="glow" cx="50%" cy="54%" r="50%"><stop offset="0" stop-color="${CORAL}" stop-opacity="0.35"/><stop offset="1" stop-color="${CORAL}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="256" height="256" rx="56" fill="url(#bg)"/>
<rect width="256" height="256" rx="56" fill="url(#glow)"/>
<path d="${arc(128, 136, 84, -135, 135)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.1" stroke-width="24" stroke-linecap="round"/>
<path d="${arc(128, 136, 84, -135, 70)}" fill="none" stroke="url(#arc)" stroke-width="24" stroke-linecap="round"/>
${spark(128, 136, 40, CORAL)}
</svg>`;
pair("plugin/marketplace", marketplace, 256);

/* Monochrome glyphs for the Stream Deck action list (white on transparent). */
const glyph = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">${body}</svg>`;
const categoryGlyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28">
<path d="${arc(14, 15, 10.5, -135, 135)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="2.6" stroke-linecap="round"/>
<path d="${arc(14, 15, 10.5, -135, 60)}" fill="none" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round"/>
${spark(14, 15, 5, "#FFFFFF")}
</svg>`;
pair("plugin/category", categoryGlyph, 28);

pair(
	"actions/gauge/icon",
	glyph(
		`<path d="${arc(10, 10.8, 7.2, -135, 135)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="2" stroke-linecap="round"/>` +
			`<path d="${arc(10, 10.8, 7.2, -135, 40)}" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>` +
			`<circle cx="10" cy="10.8" r="1.6" fill="#FFFFFF"/>`,
	),
	20,
);
pair(
	"actions/overview/icon",
	glyph(
		`<rect x="2.5" y="4" width="15" height="2.4" rx="1.2" fill="#FFFFFF" fill-opacity="0.45"/><rect x="2.5" y="4" width="9" height="2.4" rx="1.2" fill="#FFFFFF"/>` +
			`<rect x="2.5" y="8.8" width="15" height="2.4" rx="1.2" fill="#FFFFFF" fill-opacity="0.45"/><rect x="2.5" y="8.8" width="12.5" height="2.4" rx="1.2" fill="#FFFFFF"/>` +
			`<rect x="2.5" y="13.6" width="15" height="2.4" rx="1.2" fill="#FFFFFF" fill-opacity="0.45"/><rect x="2.5" y="13.6" width="5" height="2.4" rx="1.2" fill="#FFFFFF"/>`,
	),
	20,
);

/* Default key images (shown before the plugin draws, and when dragging from the action list). */
const NOW = Date.now();
const H = 3_600_000;
const sample: LimitWindow[] = [
	{ id: "five_hour", label: "Session", short: "SESSION", percent: 42, resetsAt: NOW + 2 * H + 15 * 60_000, windowMs: 5 * H },
	{ id: "seven_day", label: "Weekly", short: "WEEKLY", percent: 63, resetsAt: NOW + 76 * H, windowMs: 7 * 24 * H },
];
const frame = { now: NOW, prefs: { ...DEFAULT_PREFS, theme: "claude" as const }, showPace: false };
pair("actions/gauge/key", renderGauge("ring", sample[0], frame), 72);
pair("actions/overview/key", renderOverview("bars", sample, frame), 72);

console.log("Icons written to", IMGS);
