import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";

import { DEFAULT_PREFS, GAUGE_STYLES, type Prefs, type ThemeName } from "../src/core/settings.js";
import type { LimitWindow } from "../src/core/usage.js";
import { formatClock, formatDuration, formatPercent } from "../src/render/format.js";
import { type Frame, renderGauge, renderMessage, renderOverview, renderStrip } from "../src/render/keys.js";
import { arc, toDataUrl } from "../src/render/svg.js";
import { severity, THEMES, usageColor } from "../src/render/theme.js";

const NOW = Date.parse("2026-10-12T15:00:00Z");
const H = 3_600_000;

const win = (percent: number, extra: Partial<LimitWindow> = {}): LimitWindow => ({
	id: "five_hour",
	label: "Session (5h)",
	short: "SESSION",
	percent,
	resetsAt: NOW + 2 * H,
	windowMs: 5 * H,
	...extra,
});

const frame = (extra: Partial<Frame> = {}): Frame => ({ now: NOW, prefs: DEFAULT_PREFS, showPace: true, ...extra });

/** Valid SVG that a real renderer accepts, with no NaN/undefined leaking into attributes. */
function assertRenderable(svg: string) {
	expect(svg.startsWith("<svg")).toBe(true);
	expect(svg).not.toMatch(/NaN|undefined|Infinity/);
	expect(() => new Resvg(svg).render()).not.toThrow();
}

describe("colours", () => {
	const prefs: Prefs = { ...DEFAULT_PREFS, theme: "heat", warnAt: 50, critAt: 80 };

	it("hits each theme stop at its threshold", () => {
		const [ok, warn, crit, max] = THEMES.heat.stops;
		expect(usageColor(0, prefs)).toBe(ok);
		expect(usageColor(50, prefs)).toBe(warn);
		expect(usageColor(80, prefs)).toBe(crit);
		expect(usageColor(100, prefs)).toBe(max);
		expect(usageColor(250, prefs)).toBe(max);
	});

	it("blends between stops", () => {
		const mid = usageColor(25, prefs);
		expect(mid).not.toBe(THEMES.heat.stops[0]);
		expect(mid).not.toBe(THEMES.heat.stops[1]);
	});

	it("mono stays neutral until critical", () => {
		const mono = { ...prefs, theme: "mono" as ThemeName };
		expect(usageColor(70, mono)).toBe(THEMES.mono.stops[0]);
		expect(usageColor(85, mono)).toBe(THEMES.mono.stops[2]);
	});

	it("classifies severity", () => {
		expect(severity(10, prefs)).toBe("ok");
		expect(severity(55, prefs)).toBe("warn");
		expect(severity(90, prefs)).toBe("crit");
		expect(severity(100, prefs)).toBe("max");
	});
});

describe("formatting", () => {
	it("formats durations compactly", () => {
		expect(formatDuration(0)).toBe("now");
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(14 * 60_000)).toBe("14m");
		expect(formatDuration(2 * H + 14 * 60_000)).toBe("2h 14m");
		expect(formatDuration(3 * H)).toBe("3h");
		expect(formatDuration(76 * H)).toBe("3d 4h");
	});

	it("formats clock countdowns", () => {
		expect(formatClock(14 * 60_000 + 5_000)).toBe("14:05");
		expect(formatClock(2 * H + 14 * 60_000)).toBe("2:14");
		expect(formatClock(30 * H)).toBe("1d 6h");
	});

	it("never rounds up to a false 100%", () => {
		expect(formatPercent(99.6)).toBe("99");
		expect(formatPercent(100)).toBe("100");
		expect(formatPercent(42.4)).toBe("42");
		expect(formatPercent(-3)).toBe("0");
	});
});

describe("svg helpers", () => {
	it("draws full circles as two arcs", () => {
		expect(arc(72, 72, 50, 0, 360).match(/A/g)).toHaveLength(2);
		expect(arc(72, 72, 50, 10, 10)).toBe("");
	});

	it("encodes data URLs", () => {
		expect(toDataUrl("<svg/>")).toBe(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
	});
});

describe("key renderers", () => {
	const cases: [string, LimitWindow][] = [
		["empty", win(0, { resetsAt: null })],
		["normal", win(42)],
		["full", win(100)],
		["over", win(140)],
		["reset passed", win(30, { resetsAt: NOW - 1000 })],
	];

	for (const style of GAUGE_STYLES) {
		for (const [name, w] of cases) {
			it(`${style} renders ${name}`, () => {
				assertRenderable(renderGauge(style, w, frame()));
				assertRenderable(renderGauge(style, w, frame({ spin: 120, pulse: 1, badge: "error", wave: 0.7 })));
			});
		}
	}

	it("shows the percentage and label", () => {
		const svg = renderGauge("ring", win(42), frame());
		expect(svg).toContain(">42<");
		expect(svg).toContain("SESSION");
		expect(svg).toContain("2h");
	});

	it("omits the pace marker when disabled", () => {
		const withPace = renderGauge("ring", win(42), frame());
		const without = renderGauge("ring", win(42), frame({ showPace: false }));
		expect(withPace.length).toBeGreaterThan(without.length);
	});

	it("renders overviews for 0–5 limits", () => {
		const many = [win(10), win(50, { id: "seven_day", short: "WEEKLY" }), win(70, { id: "a", short: "OPUS" }), win(95, { id: "b", short: "SONNET" }), win(5, { id: "c", short: "X" })];
		for (let n = 0; n <= many.length; n++) {
			assertRenderable(renderOverview("bars", many.slice(0, n), frame()));
			assertRenderable(renderOverview("dual", many.slice(0, n), frame({ spin: 10 })));
		}
	});

	it("renders the touch strip, focusing the requested limit", () => {
		const list = [win(10), win(70, { id: "seven_day", short: "WEEKLY" })];
		const svg = renderStrip(list, "seven_day", frame());
		assertRenderable(svg);
		expect(svg).toContain(">70<");
		assertRenderable(renderStrip([], undefined, frame()));
	});

	it("renders every status screen on keys and strips", () => {
		for (const kind of ["setup", "loading", "auth", "cloudflare", "network", "rate_limit", "error", "empty"] as const) {
			assertRenderable(renderMessage(kind, frame({ spin: 45 })));
			assertRenderable(renderMessage(kind, frame(), { w: 200, h: 100 }));
		}
	});

	it("escapes labels", () => {
		const svg = renderGauge("ring", win(5, { short: "<B&D>" }), frame());
		expect(svg).toContain("&lt;B&amp;D&gt;");
	});
});
