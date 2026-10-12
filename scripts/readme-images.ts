/**
 * Builds the README artwork from the real renderers: a device mock-up, a style gallery, theme
 * swatches, the Stream Deck + strip, status screens and an animated refresh GIF (needs ImageMagick).
 *
 *   npx tsx scripts/readme-images.ts
 */

import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PREFS, type Prefs, type ThemeName } from "../src/core/settings.js";
import type { LimitWindow } from "../src/core/usage.js";
import { type Frame, type MessageKind, renderGauge, renderMessage, renderOverview, renderStrip } from "../src/render/keys.js";

const OUT = "docs/images";
mkdirSync(OUT, { recursive: true });

const NOW = Date.parse("2026-10-12T15:00:00Z");
const H = 3_600_000;
const FONT = { loadSystemFonts: true, sansSerifFamily: "Liberation Sans", defaultFontFamily: "Liberation Sans" };

const session = (percent: number): LimitWindow => ({ id: "five_hour", label: "Session", short: "SESSION", percent, resetsAt: NOW + 2 * H + 14 * 60_000, windowMs: 5 * H });
const weekly = (percent: number): LimitWindow => ({ id: "seven_day", label: "Weekly", short: "WEEKLY", percent, resetsAt: NOW + 76 * H, windowMs: 7 * 24 * H });
const fable = (percent: number): LimitWindow => ({ id: "model:fable", label: "Fable", short: "FABLE", percent, resetsAt: NOW + 76 * H, windowMs: 7 * 24 * H });

const frame = (theme: ThemeName = "heat", extra: Partial<Frame> = {}): Frame => {
	const prefs: Prefs = { ...DEFAULT_PREFS, theme };
	return { now: NOW, prefs, showPace: true, ...extra };
};

function png(svg: string, width: number): Buffer {
	return new Resvg(svg, { fitTo: { mode: "width", value: width }, font: FONT }).render().asPng();
}

/**
 * Inlines a rendered key as a nested <svg> (so it shares the font database), namespacing its ids so
 * several keys can live in one document.
 */
function nest(svg: string, x: number, y: number, w: number, h: number, id: string): string {
	return svg
		.replace(/id="(\w+)"/g, `id="${id}-$1"`)
		.replace(/url\(#(\w+)\)/g, `url(#${id}-$1)`)
		.replace(/^<svg [^>]*viewBox="([^"]+)">/, `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="$1">`);
}

/** A key image with rounded corners, as it looks on the device. */
function key(svg: string, x: number, y: number, size: number, id: string): string {
	return (
		`<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${size * 0.16}"/></clipPath>` +
		`<g clip-path="url(#${id})">${nest(svg, x, y, size, size, id)}</g>`
	);
}

function caption(x: number, y: number, label: string, size = 15, fill = "#A1A1AA"): string {
	return `<text x="${x}" y="${y}" font-family="Liberation Sans" font-size="${size}" font-weight="bold" fill="${fill}" text-anchor="middle">${label}</text>`;
}

/* ------------------------------------------------------------------------------------------------
 * Hero: a 5×3 Stream Deck showing a mix of styles
 * ---------------------------------------------------------------------------------------------- */
{
	const K = 120;
	const gap = 26;
	const pad = 46;
	const cols = 5;
	const rows = 3;
	const w = pad * 2 + cols * K + (cols - 1) * gap;
	const h = pad * 2 + rows * K + (rows - 1) * gap;
	const grid: string[] = [
		renderGauge("ring", session(46), frame()),
		renderGauge("liquid", weekly(71), frame()),
		renderOverview("bars", [session(46), weekly(71), fable(12)], frame()),
		renderGauge("countdown", session(46), frame()),
		renderGauge("number", fable(12), frame()),
		renderOverview("dual", [session(46), weekly(71)], frame()),
		renderGauge("ring", session(92), frame("heat", { pulse: 1 })),
		renderGauge("liquid", session(28), frame("ocean")),
		renderGauge("ring", weekly(63), frame("claude")),
		renderGauge("number", weekly(88), frame("mono")),
		renderGauge("countdown", weekly(63), frame("ocean")),
		renderOverview("bars", [session(23), weekly(41)], frame("claude")),
		renderMessage("setup", frame()),
		renderGauge("liquid", session(97), frame("heat", { pulse: 1, wave: 0.6 })),
		renderOverview("dual", [session(12), weekly(35)], frame("ocean")),
	];
	let body =
		`<defs><linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A2A2E"/><stop offset="1" stop-color="#18181B"/></linearGradient></defs>` +
		`<rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="40" fill="url(#body)" stroke="#3F3F46" stroke-width="2"/>`;
	grid.forEach((svg, i) => {
		const x = pad + (i % cols) * (K + gap);
		const y = pad + Math.floor(i / cols) * (K + gap);
		body += `<rect x="${x - 3}" y="${y - 3}" width="${K + 6}" height="${K + 6}" rx="${K * 0.18}" fill="#000"/>`;
		body += key(svg, x, y, K, `k${i}`);
	});
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
	writeFileSync(join(OUT, "hero.png"), png(svg, w * 2));
}

/* ------------------------------------------------------------------------------------------------
 * Style gallery with captions
 * ---------------------------------------------------------------------------------------------- */
function gallery(name: string, items: [string, string][], K = 144): void {
	const gap = 28;
	const w = items.length * K + (items.length - 1) * gap + 40;
	const h = K + 70;
	let body = `<rect width="${w}" height="${h}" rx="18" fill="#18181B"/>`;
	items.forEach(([label, svg], i) => {
		const x = 20 + i * (K + gap);
		body += key(svg, x, 20, K, `${name}${i}`);
		body += caption(x + K / 2, 20 + K + 32, label);
	});
	writeFileSync(join(OUT, `${name}.png`), png(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`, w * 1.5));
}

gallery("styles", [
	["Ring", renderGauge("ring", session(46), frame())],
	["Liquid", renderGauge("liquid", weekly(71), frame())],
	["Number", renderGauge("number", session(63), frame())],
	["Timer", renderGauge("countdown", session(46), frame())],
	["Bars", renderOverview("bars", [session(46), weekly(71), fable(12)], frame())],
	["Dual ring", renderOverview("dual", [session(46), weekly(71)], frame())],
]);

gallery("themes", [
	["Heat", renderGauge("ring", session(55), frame("heat"))],
	["Claude", renderGauge("ring", session(55), frame("claude"))],
	["Ocean", renderGauge("ring", session(55), frame("ocean"))],
	["Mono", renderGauge("ring", session(55), frame("mono"))],
]);

gallery("levels", [
	["12%", renderGauge("ring", session(12), frame())],
	["38%", renderGauge("ring", session(38), frame())],
	["57%", renderGauge("ring", session(57), frame())],
	["79%", renderGauge("ring", session(79), frame())],
	["91%", renderGauge("ring", session(91), frame("heat", { pulse: 0.8 }))],
	["100%", renderGauge("ring", session(100), frame("heat", { pulse: 1 }))],
]);

gallery(
	"states",
	(["setup", "auth", "cloudflare", "network"] as MessageKind[]).map((k) => [
		{ setup: "Not connected", auth: "Cookie expired", cloudflare: "Cloudflare", network: "Offline" }[k as string]!,
		renderMessage(k, frame()),
	]),
);

/* ------------------------------------------------------------------------------------------------
 * Stream Deck + strip
 * ---------------------------------------------------------------------------------------------- */
{
	const strips = [
		renderStrip([session(46), weekly(71), fable(12)], "five_hour", frame()),
		renderStrip([session(46), weekly(88), fable(12)], "seven_day", frame()),
	];
	const w = 2 * 200 + 3 * 16;
	const h = 100 + 32;
	let body = `<rect width="${w}" height="${h}" rx="14" fill="#18181B"/>`;
	strips.forEach((svg, i) => {
		body += nest(svg, 16 + i * 216, 16, 200, 100, `s${i}`);
	});
	writeFileSync(join(OUT, "strip.png"), png(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`, w * 2));
}

/* ------------------------------------------------------------------------------------------------
 * Animated refresh: spinner, then the values sweep up
 * ---------------------------------------------------------------------------------------------- */
try {
	const dir = mkdtempSync(join(tmpdir(), "cu-gif-"));
	const K = 144;
	const gap = 20;
	const w = 3 * K + 2 * gap + 40;
	const h = K + 40;
	const ease = (t: number) => 1 - (1 - t) ** 3;
	const frames: string[] = [];
	const total = 40;
	for (let i = 0; i < total; i++) {
		const spinning = i < 12;
		const t = spinning ? 0 : Math.min(1, (i - 12) / 14);
		const v = (target: number) => (spinning ? target : target * ease(t));
		const extra: Partial<Frame> = spinning ? { spin: (i * 40) % 360 } : { wave: (i % 20) / 20 };
		const keys = [
			renderGauge("ring", session(v(46)), frame("heat", extra)),
			renderGauge("liquid", weekly(v(71)), frame("heat", extra)),
			renderOverview("bars", [session(v(46)), weekly(v(71)), fable(v(12))], frame("heat", extra)),
		];
		let body = `<rect width="${w}" height="${h}" fill="#18181B"/>`;
		keys.forEach((svg, k) => (body += key(svg, 20 + k * (K + gap), 20, K, `g${k}`)));
		const file = join(dir, `f${String(i).padStart(3, "0")}.png`);
		writeFileSync(file, png(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`, w));
		frames.push(file);
	}
	execFileSync("convert", ["-delay", "6", "-loop", "0", ...frames, "-delay", "150", frames[frames.length - 1], "-layers", "Optimize", join(OUT, "refresh.gif")]);
	rmSync(dir, { recursive: true, force: true });
} catch (err) {
	console.warn("Skipping refresh.gif (ImageMagick not available?)", err instanceof Error ? err.message : err);
}

console.log(`README images written to ${OUT}`);
