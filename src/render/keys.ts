/**
 * Key and touch-strip artwork. Every function is pure: give it the (possibly animated) usage values
 * plus a `Frame` describing time/animation state and it returns an SVG document string.
 *
 * Keys are drawn on a 144×144 canvas (Stream Deck's @2x key size) and scale down cleanly.
 */

import type { GaugeStyle, OverviewStyle, Prefs } from "../core/settings.js";
import { elapsedFraction, type LimitWindow } from "../core/usage.js";
import { formatClock, formatDuration, formatPercent } from "./format.js";
import { arc, percentText, polar, svgDoc, text } from "./svg.js";
import { accent, BG, MUTED, severity, shade, SOFT, TEXT, TRACK, usageColor } from "./theme.js";

export type Frame = {
	now: number;
	prefs: Prefs;
	/** Spinner angle (degrees) while a refresh the user asked for is running. */
	spin?: number | null;
	/** 0–1 extra glow, driven by the critical-usage pulse. */
	pulse?: number;
	/** 0–1 phase of the liquid wave. */
	wave?: number;
	/** Small corner badge: data is stale (warn) or credentials need attention (error). */
	badge?: "warn" | "error" | null;
	/** Draw the "where you should be" time marker. */
	showPace?: boolean;
};

const S = 144;
const GAUGE_FROM = -135;
const GAUGE_SWEEP = 270;

/* ================================================================================================
 * Shared chrome
 * ============================================================================================== */

function backdrop(color: string, f: Frame, strength = 0.26): string {
	const glow = Math.min(0.7, strength + (f.pulse ?? 0) * 0.34);
	return (
		`<defs><radialGradient id="g" cx="50%" cy="50%" r="50%">` +
		`<stop offset="0" stop-color="${color}" stop-opacity="${glow.toFixed(2)}"/>` +
		`<stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>` +
		`<rect width="${S}" height="${S}" fill="${BG}"/>` +
		`<rect width="${S}" height="${S}" fill="url(#g)"/>`
	);
}

function badge(kind: Frame["badge"], size = S): string {
	if (!kind) return "";
	const fill = kind === "error" ? "#F43F5E" : "#FBBF24";
	const cx = size - 14;
	return (
		`<circle cx="${cx}" cy="14" r="9" fill="${BG}"/>` +
		`<circle cx="${cx}" cy="14" r="7" fill="${fill}"/>` +
		`<rect x="${cx - 1.2}" y="9.5" width="2.4" height="5.6" rx="1.2" fill="${BG}"/>` +
		`<circle cx="${cx}" cy="18" r="1.3" fill="${BG}"/>`
	);
}

function countdownLabel(w: LimitWindow, now: number): string {
	if (w.resetsAt === null) return w.percent > 0 ? "—" : "ready";
	return formatDuration(w.resetsAt - now);
}

/** Small clock glyph + text, centred as a group. */
function clockLine(cx: number, y: number, label: string, size: number, fill: string): string {
	const width = label.length * size * 0.56;
	const iconR = size * 0.36;
	const total = width + iconR * 2 + 5;
	const ix = cx - total / 2 + iconR;
	const iy = y - size * 0.35;
	return (
		`<circle cx="${ix.toFixed(1)}" cy="${iy.toFixed(1)}" r="${iconR.toFixed(1)}" fill="none" stroke="${fill}" stroke-width="1.6" stroke-opacity="0.8"/>` +
		`<path d="M${ix.toFixed(1)} ${(iy - iconR * 0.55).toFixed(1)}V${iy.toFixed(1)}l${(iconR * 0.45).toFixed(1)} ${(iconR * 0.3).toFixed(1)}" fill="none" stroke="${fill}" stroke-width="1.6" stroke-linecap="round" stroke-opacity="0.8"/>` +
		text(ix + iconR + 5, y, label, { size, fill, weight: 600, anchor: "start" })
	);
}

function paceTick(cx: number, cy: number, r: number, deg: number, len: number): string {
	const [x1, y1] = polar(cx, cy, r - len, deg);
	const [x2, y2] = polar(cx, cy, r + len, deg);
	return (
		`<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${BG}" stroke-width="6" stroke-linecap="round"/>` +
		`<path d="M${x1} ${y1}L${x2} ${y2}" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round"/>`
	);
}

function spinner(cx: number, cy: number, r: number, width: number, deg: number, color: string): string {
	return `<path d="${arc(cx, cy, r, deg, deg + 70)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
}

function clampPct(p: number): number {
	return Math.max(0, Math.min(100, p));
}

/* ================================================================================================
 * Single-limit gauges
 * ============================================================================================== */

export function renderGauge(style: GaugeStyle, w: LimitWindow, f: Frame): string {
	switch (style) {
		case "liquid":
			return liquid(w, f);
		case "number":
			return bigNumber(w, f);
		case "countdown":
			return countdown(w, f);
		default:
			return ring(w, f);
	}
}

function ring(w: LimitWindow, f: Frame): string {
	const color = usageColor(w.percent, f.prefs);
	const cx = 72;
	const cy = 76;
	const r = 52;
	const sw = 12;
	const pct = clampPct(w.percent);
	const end = GAUGE_FROM + (GAUGE_SWEEP * pct) / 100;
	const busy = f.spin !== null && f.spin !== undefined;

	let body = backdrop(color, f);
	body += `<path d="${arc(cx, cy, r, GAUGE_FROM, GAUGE_FROM + GAUGE_SWEEP)}" fill="none" stroke="${TRACK}" stroke-opacity="0.1" stroke-width="${sw}" stroke-linecap="round"/>`;
	if (pct > 0.5) {
		body += `<path d="${arc(cx, cy, r, GAUGE_FROM, Math.max(GAUGE_FROM + 1, end))}" fill="none" stroke="${color}" stroke-opacity="${busy ? 0.45 : 1}" stroke-width="${sw}" stroke-linecap="round"/>`;
	}
	const elapsed = f.showPace === false ? null : elapsedFraction(w, f.now);
	if (elapsed !== null && !busy) {
		body += paceTick(cx, cy, r, GAUGE_FROM + GAUGE_SWEEP * elapsed, 9);
	}
	if (busy) body += spinner(cx, cy, r, sw, f.spin!, TEXT);

	body += text(cx, 60, w.short, { size: 13, fill: MUTED, weight: "bold", spacing: 1 });
	body += text(cx, 96, percentText(formatPercent(w.percent), 38), { size: 38, fill: TEXT, weight: "bold", raw: true });
	body += clockLine(cx, 136, countdownLabel(w, f.now), 16, SOFT);
	body += badge(f.badge);
	return svgDoc(S, S, body);
}

function liquid(w: LimitWindow, f: Frame): string {
	const color = usageColor(w.percent, f.prefs);
	const pct = clampPct(w.percent);
	const level = S - (S * pct) / 100;
	const amp = pct > 0 && pct < 100 ? 4 : 0;
	const phase = (f.wave ?? 0) % 1;

	const wave = (offset: number, a: number) => {
		const x0 = -72 + ((offset * 72) % 72);
		let d = `M${x0.toFixed(1)} ${level.toFixed(1)}`;
		d += `q18 ${-a} 36 0t36 0t36 0t36 0t36 0t36 0`;
		return `${d}V${S}H${x0.toFixed(1)}Z`;
	};

	let body =
		`<defs><linearGradient id="lq" x1="0" y1="0" x2="0" y2="1">` +
		`<stop offset="0" stop-color="${shade(color, 0.18)}"/><stop offset="1" stop-color="${shade(color, -0.45)}"/></linearGradient></defs>` +
		`<rect width="${S}" height="${S}" fill="${BG}"/>`;
	if (pct > 0) {
		body += `<path d="${wave(phase + 0.5, amp * 0.8)}" fill="${color}" fill-opacity="0.35"/>`;
		body += `<path d="${wave(phase, amp)}" fill="url(#lq)"/>`;
	}
	// Subtle rim so an empty key still reads as a container.
	body += `<rect x="1.5" y="1.5" width="${S - 3}" height="${S - 3}" rx="18" fill="none" stroke="${color}" stroke-opacity="${(0.35 + (f.pulse ?? 0) * 0.5).toFixed(2)}" stroke-width="3"/>`;

	if (f.spin !== null && f.spin !== undefined) {
		body += spinner(72, 72, 60, 5, f.spin, TEXT);
	}
	const elapsed = f.showPace === false ? null : elapsedFraction(w, f.now);
	if (elapsed !== null) {
		// Pace marker: a notch on the left edge at the height usage "should" be at.
		const y = S - S * elapsed;
		body += `<path d="M2 ${y.toFixed(1)}h14" stroke="${BG}" stroke-width="6" stroke-linecap="round"/>`;
		body += `<path d="M2 ${y.toFixed(1)}h14" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round"/>`;
	}

	body += text(72, 30, w.short, { size: 14, fill: TEXT, weight: "bold", spacing: 1.5, opacity: 0.9, shadow: true });
	body += text(72, 90, percentText(formatPercent(w.percent), 46), { size: 46, fill: TEXT, weight: "bold", shadow: true, raw: true });
	body += text(72, 128, countdownLabel(w, f.now), { size: 17, fill: TEXT, weight: 600, opacity: 0.92, shadow: true });
	body += badge(f.badge);
	return svgDoc(S, S, body);
}

function bigNumber(w: LimitWindow, f: Frame): string {
	const color = usageColor(w.percent, f.prefs);
	const pct = clampPct(w.percent);
	const x = 16;
	const width = S - 32;
	const busy = f.spin !== null && f.spin !== undefined;

	let body = backdrop(color, f, 0.2);
	body += text(72, 30, w.short, { size: 14, fill: MUTED, weight: "bold", spacing: 1.5 });
	body += text(72, 90, percentText(formatPercent(w.percent), 56), { size: 56, fill: color, weight: "bold", raw: true });

	body += `<rect x="${x}" y="104" width="${width}" height="9" rx="4.5" fill="${TRACK}" fill-opacity="0.12"/>`;
	if (busy) {
		const t = ((f.spin ?? 0) % 360) / 360;
		const seg = width * 0.3;
		const sx = x + (width - seg) * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
		body += `<rect x="${sx.toFixed(1)}" y="104" width="${seg.toFixed(1)}" height="9" rx="4.5" fill="${TEXT}" fill-opacity="0.85"/>`;
	} else if (pct > 0) {
		body += `<rect x="${x}" y="104" width="${Math.max(9, (width * pct) / 100).toFixed(1)}" height="9" rx="4.5" fill="${color}"/>`;
	}
	const elapsed = f.showPace === false ? null : elapsedFraction(w, f.now);
	if (elapsed !== null && !busy) {
		const px = (x + width * elapsed).toFixed(1);
		body += `<path d="M${px} 100V117" stroke="${BG}" stroke-width="5" stroke-linecap="round"/><path d="M${px} 100V117" stroke="#FFF" stroke-width="2.2" stroke-linecap="round"/>`;
	}
	body += clockLine(72, 137, countdownLabel(w, f.now), 15, SOFT);
	body += badge(f.badge);
	return svgDoc(S, S, body);
}

function countdown(w: LimitWindow, f: Frame): string {
	const color = usageColor(w.percent, f.prefs);
	const cx = 72;
	const cy = 72;
	const r = 59;
	const sw = 9;
	const remaining = w.resetsAt === null ? null : Math.max(0, w.resetsAt - f.now);
	const left = remaining !== null && w.windowMs ? Math.max(0, Math.min(1, remaining / w.windowMs)) : 0;
	const busy = f.spin !== null && f.spin !== undefined;

	let body = backdrop(color, f);
	body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${TRACK}" stroke-opacity="0.1" stroke-width="${sw}"/>`;
	if (left > 0.002 && !busy) {
		// Time left, draining counter-clockwise toward 12 o'clock as the reset approaches.
		body += `<path d="${arc(cx, cy, r, 360 - 360 * left, 360)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
	}
	if (busy) body += spinner(cx, cy, r, sw, f.spin!, TEXT);

	const big = remaining === null ? "—" : formatClock(remaining);
	const size = big.length > 5 ? 26 : 32;
	body += text(cx, 50, w.short, { size: 12, fill: MUTED, weight: "bold", spacing: 1 });
	body += text(cx, 84, big, { size, fill: TEXT, weight: "bold" });
	body += text(cx, 106, remaining === null ? "not started" : `${formatPercent(w.percent)}% used`, {
		size: 14,
		fill: color,
		weight: 600,
	});
	body += badge(f.badge);
	return svgDoc(S, S, body);
}

/* ================================================================================================
 * Multi-limit overview
 * ============================================================================================== */

export function renderOverview(style: OverviewStyle, windows: readonly LimitWindow[], f: Frame): string {
	if (style === "dual" && windows.length >= 2) return dual(windows, f);
	return bars(windows, f);
}

function bars(windows: readonly LimitWindow[], f: Frame): string {
	const rows = windows.slice(0, 4);
	const n = Math.max(1, rows.length);
	const worst = rows.reduce((m, w) => Math.max(m, w.percent), 0);
	const color = usageColor(worst, f.prefs);
	const top = n <= 2 ? 14 : 10;
	const rowH = (S - top - (n <= 2 ? 8 : 6)) / n;
	const labelSize = n <= 2 ? 15 : n === 3 ? 13 : 12;
	const barH = n <= 2 ? 10 : n === 3 ? 8 : 6;
	const x = 12;
	const width = S - 24;
	const busy = f.spin !== null && f.spin !== undefined;

	let body = backdrop(color, f, 0.16);
	rows.forEach((w, i) => {
		const c = usageColor(w.percent, f.prefs);
		const y0 = top + i * rowH;
		const baseline = y0 + labelSize;
		const barY = baseline + (n <= 2 ? 7 : 5);
		const pct = clampPct(w.percent);

		body += text(x, baseline, w.short, { size: labelSize, fill: MUTED, weight: "bold", anchor: "start", spacing: 0.5 });
		body += text(S - x, baseline + 1, percentText(formatPercent(w.percent), labelSize + 5), {
			size: labelSize + 5,
			fill: TEXT,
			weight: "bold",
			anchor: "end",
			raw: true,
		});
		body += `<rect x="${x}" y="${barY.toFixed(1)}" width="${width}" height="${barH}" rx="${barH / 2}" fill="${TRACK}" fill-opacity="0.12"/>`;
		if (pct > 0) {
			body += `<rect x="${x}" y="${barY.toFixed(1)}" width="${Math.max(barH, (width * pct) / 100).toFixed(1)}" height="${barH}" rx="${barH / 2}" fill="${c}" fill-opacity="${busy ? 0.45 : 1}"/>`;
		}
		const elapsed = f.showPace === false ? null : elapsedFraction(w, f.now);
		if (elapsed !== null) {
			const px = (x + width * elapsed).toFixed(1);
			body += `<path d="M${px} ${(barY - 3).toFixed(1)}V${(barY + barH + 3).toFixed(1)}" stroke="${BG}" stroke-width="4.5" stroke-linecap="round"/>`;
			body += `<path d="M${px} ${(barY - 3).toFixed(1)}V${(barY + barH + 3).toFixed(1)}" stroke="#FFF" stroke-width="2" stroke-linecap="round"/>`;
		}
		if (n <= 2) {
			body += clockLine(S / 2, barY + barH + 19, countdownLabel(w, f.now), 14, SOFT);
		}
	});
	if (busy) {
		const t = ((f.spin ?? 0) % 360) / 360;
		body += `<rect x="${(12 + (S - 24 - 30) * (0.5 - 0.5 * Math.cos(t * Math.PI * 2))).toFixed(1)}" y="2" width="30" height="3" rx="1.5" fill="${TEXT}" fill-opacity="0.85"/>`;
	}
	if (rows.length === 0) {
		body += text(72, 78, "No limits", { size: 15, fill: MUTED, weight: 600 });
	}
	body += badge(f.badge);
	return svgDoc(S, S, body);
}

function dual(windows: readonly LimitWindow[], f: Frame): string {
	const [outer, inner] = windows;
	const co = usageColor(outer.percent, f.prefs);
	const ci = usageColor(inner.percent, f.prefs);
	const worst = Math.max(outer.percent, inner.percent);
	const cx = 72;
	const cy = 72;
	const busy = f.spin !== null && f.spin !== undefined;

	const ringOf = (w: LimitWindow, r: number, sw: number, color: string) => {
		const pct = clampPct(w.percent);
		let s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${TRACK}" stroke-opacity="0.1" stroke-width="${sw}"/>`;
		if (pct > 0.5) {
			s += `<path d="${arc(cx, cy, r, 0, (360 * pct) / 100)}" fill="none" stroke="${color}" stroke-opacity="${busy ? 0.45 : 1}" stroke-width="${sw}" stroke-linecap="round"/>`;
		}
		const elapsed = f.showPace === false ? null : elapsedFraction(w, f.now);
		if (elapsed !== null && !busy) s += paceTick(cx, cy, r, 360 * elapsed, sw / 2 + 2);
		return s;
	};

	let body = backdrop(usageColor(worst, f.prefs), f, 0.2);
	body += ringOf(outer, 62, 10, co);
	body += ringOf(inner, 47, 10, ci);
	if (busy) body += spinner(cx, cy, 62, 10, f.spin!, TEXT);

	body += text(cx, 66, percentText(formatPercent(outer.percent), 28), { size: 28, fill: TEXT, weight: "bold", raw: true });
	body += text(cx, 80, outer.short, { size: 9, fill: MUTED, weight: "bold", spacing: 1 });
	body += `<path d="M${cx - 16} 88H${cx + 16}" stroke="${TRACK}" stroke-opacity="0.18" stroke-width="1.5"/>`;
	body += text(cx, 104, percentText(formatPercent(inner.percent), 17), { size: 17, fill: ci, weight: "bold", raw: true });
	body += badge(f.badge);
	return svgDoc(S, S, body);
}

/* ================================================================================================
 * Stream Deck + touch strip (200×100 per dial)
 * ============================================================================================== */

export function renderStrip(windows: readonly LimitWindow[], focusId: string | undefined, f: Frame): string {
	const W = 200;
	const H = 100;
	const focus = windows.find((w) => w.id === focusId) ?? windows[0];
	if (!focus) return svgDoc(W, H, `<rect width="${W}" height="${H}" fill="${BG}"/>`);

	const color = usageColor(focus.percent, f.prefs);
	const cx = 48;
	const cy = 52;
	const r = 36;
	const sw = 9;
	const pct = clampPct(focus.percent);
	const busy = f.spin !== null && f.spin !== undefined;

	let body =
		`<defs><radialGradient id="g" cx="24%" cy="50%" r="60%">` +
		`<stop offset="0" stop-color="${color}" stop-opacity="${Math.min(0.6, 0.24 + (f.pulse ?? 0) * 0.3).toFixed(2)}"/>` +
		`<stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>` +
		`<rect width="${W}" height="${H}" fill="${BG}"/><rect width="${W}" height="${H}" fill="url(#g)"/>`;

	body += `<path d="${arc(cx, cy, r, GAUGE_FROM, GAUGE_FROM + GAUGE_SWEEP)}" fill="none" stroke="${TRACK}" stroke-opacity="0.1" stroke-width="${sw}" stroke-linecap="round"/>`;
	if (pct > 0.5) {
		body += `<path d="${arc(cx, cy, r, GAUGE_FROM, GAUGE_FROM + (GAUGE_SWEEP * pct) / 100)}" fill="none" stroke="${color}" stroke-opacity="${busy ? 0.45 : 1}" stroke-width="${sw}" stroke-linecap="round"/>`;
	}
	const elapsed = f.showPace === false ? null : elapsedFraction(focus, f.now);
	if (elapsed !== null && !busy) body += paceTick(cx, cy, r, GAUGE_FROM + GAUGE_SWEEP * elapsed, 7);
	if (busy) body += spinner(cx, cy, r, sw, f.spin!, TEXT);
	body += text(cx, 60, percentText(formatPercent(focus.percent), 24), { size: 24, fill: TEXT, weight: "bold", raw: true });
	body += text(cx, 95, focus.resetsAt === null ? "ready" : formatDuration(focus.resetsAt - f.now), {
		size: 12,
		fill: SOFT,
		weight: 600,
	});

	// Right column: every limit, focused one highlighted.
	const rows = windows.slice(0, 4);
	const x = 100;
	const width = 90;
	const rowH = Math.min(30, 88 / Math.max(1, rows.length));
	const top = (H - rowH * rows.length) / 2;
	rows.forEach((w, i) => {
		const y = top + i * rowH;
		const active = w.id === focus.id;
		const c = usageColor(w.percent, f.prefs);
		if (active) {
			body += `<rect x="${x - 6}" y="${(y + 1).toFixed(1)}" width="${width + 10}" height="${(rowH - 2).toFixed(1)}" rx="6" fill="${TRACK}" fill-opacity="0.07"/>`;
		}
		body += text(x, y + 13, w.short, { size: 10, fill: active ? TEXT : MUTED, weight: "bold", anchor: "start", spacing: 0.5 });
		body += text(x + width, y + 13.5, `${formatPercent(w.percent)}%`, { size: 12, fill: active ? TEXT : SOFT, weight: "bold", anchor: "end" });
		body += `<rect x="${x}" y="${(y + 18).toFixed(1)}" width="${width}" height="4" rx="2" fill="${TRACK}" fill-opacity="0.12"/>`;
		if (w.percent > 0) {
			body += `<rect x="${x}" y="${(y + 18).toFixed(1)}" width="${Math.max(4, (width * clampPct(w.percent)) / 100).toFixed(1)}" height="4" rx="2" fill="${c}"/>`;
		}
	});

	body += badge(f.badge, W);
	return svgDoc(W, H, body);
}

/* ================================================================================================
 * Status screens (setup, loading, errors)
 * ============================================================================================== */

export type MessageKind = "setup" | "loading" | "auth" | "cloudflare" | "network" | "rate_limit" | "error" | "empty";

const MESSAGES: Record<MessageKind, { title: string; sub: string }> = {
	setup: { title: "CONNECT", sub: "open settings" },
	loading: { title: "LOADING", sub: "claude.ai" },
	auth: { title: "SIGN IN", sub: "cookie expired" },
	cloudflare: { title: "BLOCKED", sub: "see settings" },
	network: { title: "OFFLINE", sub: "retrying…" },
	rate_limit: { title: "PAUSED", sub: "rate limited" },
	error: { title: "ERROR", sub: "see settings" },
	empty: { title: "NO DATA", sub: "no limits yet" },
};

export function renderMessage(kind: MessageKind, f: Frame, size: { w: number; h: number } = { w: S, h: S }): string {
	const { title, sub } = MESSAGES[kind];
	const tint = kind === "setup" || kind === "loading" ? accent(f.prefs) : kind === "network" || kind === "rate_limit" ? "#FBBF24" : "#F43F5E";
	const strip = size.w !== size.h;
	const cx = strip ? 48 : 72;
	const cy = strip ? 50 : 56;

	let body =
		`<defs><radialGradient id="g" cx="${strip ? "24%" : "50%"}" cy="40%" r="60%">` +
		`<stop offset="0" stop-color="${tint}" stop-opacity="0.22"/><stop offset="1" stop-color="${tint}" stop-opacity="0"/></radialGradient></defs>` +
		`<rect width="${size.w}" height="${size.h}" fill="${BG}"/><rect width="${size.w}" height="${size.h}" fill="url(#g)"/>`;

	body += icon(kind, cx, cy, tint, f);
	if (strip) {
		body += text(98, 47, title, { size: 15, fill: TEXT, weight: "bold", anchor: "start", spacing: 0.8 });
		body += text(98, 66, sub, { size: 12, fill: MUTED, weight: 600, anchor: "start" });
	} else {
		body += text(72, 112, title, { size: 17, fill: TEXT, weight: "bold", spacing: 1.2 });
		body += text(72, 132, sub, { size: 13, fill: MUTED, weight: 600 });
	}
	return svgDoc(size.w, size.h, body);
}

function icon(kind: MessageKind, cx: number, cy: number, tint: string, f: Frame): string {
	switch (kind) {
		case "setup":
			return spark(cx, cy, 26, tint, f.spin ?? 0);
		case "loading":
			return (
				`<circle cx="${cx}" cy="${cy}" r="26" fill="none" stroke="${TRACK}" stroke-opacity="0.1" stroke-width="7"/>` +
				spinner(cx, cy, 26, 7, f.spin ?? 0, tint)
			);
		case "auth":
			return (
				`<path d="M${cx - 12} ${cy - 4}v-8a12 12 0 0 1 24 0v8" fill="none" stroke="${tint}" stroke-width="6" stroke-linecap="round"/>` +
				`<rect x="${cx - 21}" y="${cy - 5}" width="42" height="32" rx="7" fill="${tint}"/>` +
				`<circle cx="${cx}" cy="${cy + 8}" r="4.5" fill="${BG}"/><rect x="${cx - 2}" y="${cy + 9}" width="4" height="9" rx="2" fill="${BG}"/>`
			);
		case "cloudflare":
			return (
				`<path d="M${cx} ${cy - 28}l24 9v15c0 16-10 26-24 32c-14-6-24-16-24-32v-15z" fill="${tint}"/>` +
				`<path d="M${cx - 9} ${cy - 3}l18 18M${cx + 9} ${cy - 3}l-18 18" stroke="${BG}" stroke-width="5" stroke-linecap="round"/>`
			);
		case "network":
			return (
				`<path d="${arc(cx, cy + 14, 30, -50, 50)}" fill="none" stroke="${tint}" stroke-width="6" stroke-linecap="round"/>` +
				`<path d="${arc(cx, cy + 14, 18, -50, 50)}" fill="none" stroke="${tint}" stroke-width="6" stroke-linecap="round"/>` +
				`<circle cx="${cx}" cy="${cy + 12}" r="5" fill="${tint}"/>` +
				`<path d="M${cx - 24} ${cy - 22}L${cx + 24} ${cy + 26}" stroke="${BG}" stroke-width="9" stroke-linecap="round"/>` +
				`<path d="M${cx - 24} ${cy - 22}L${cx + 24} ${cy + 26}" stroke="${tint}" stroke-width="5" stroke-linecap="round"/>`
			);
		case "rate_limit":
			return (
				`<path d="M${cx - 16} ${cy - 26}h32M${cx - 16} ${cy + 26}h32" stroke="${tint}" stroke-width="6" stroke-linecap="round"/>` +
				`<path d="M${cx - 13} ${cy - 24}c0 14 26 14 26 24s-26 10-26 24M${cx + 13} ${cy - 24}c0 14-26 14-26 24s26 10 26 24" fill="none" stroke="${tint}" stroke-width="5" stroke-linecap="round"/>`
			);
		default:
			return (
				`<circle cx="${cx}" cy="${cy}" r="26" fill="${tint}"/>` +
				`<rect x="${cx - 3.5}" y="${cy - 16}" width="7" height="20" rx="3.5" fill="${BG}"/><circle cx="${cx}" cy="${cy + 12}" r="4" fill="${BG}"/>`
			);
	}
}

/** A friendly eight-point spark (our mark — deliberately not Anthropic's logo). */
export function spark(cx: number, cy: number, r: number, color: string, rotate = 0): string {
	let d = "";
	for (let i = 0; i < 8; i++) {
		const a = rotate / 4 + i * 45;
		const len = i % 2 === 0 ? r : r * 0.62;
		const [x1, y1] = polar(cx, cy, r * 0.18, a);
		const [x2, y2] = polar(cx, cy, len, a);
		d += `M${x1} ${y1}L${x2} ${y2}`;
	}
	return `<path d="${d}" stroke="${color}" stroke-width="${(r * 0.24).toFixed(1)}" stroke-linecap="round"/>`;
}

export { severity };
