/**
 * Tiny SVG helpers. Output sticks to SVG Tiny 1.2 features (paths, gradients, basic text) because
 * that's what Stream Deck's renderer reliably supports: no filters, masks, CSS or dominant-baseline.
 */

export const FONT = "Helvetica Neue, Helvetica, Segoe UI, Arial, sans-serif";

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Point on a circle; angle in degrees, clockwise from 12 o'clock. */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
	const rad = (deg * Math.PI) / 180;
	return [r1(cx + r * Math.sin(rad)), r1(cy - r * Math.cos(rad))];
}

/** Arc path from `from`° to `to`° (clockwise, 12 o'clock = 0°). */
export function arc(cx: number, cy: number, r: number, from: number, to: number): string {
	let sweep = to - from;
	if (sweep <= 0) return "";
	if (sweep >= 360) {
		// A single arc can't draw a full circle; use two halves.
		sweep = 359.99;
		const [mx, my] = polar(cx, cy, r, from + 180);
		const [sx, sy] = polar(cx, cy, r, from);
		return `M${sx} ${sy}A${r} ${r} 0 0 1 ${mx} ${my}A${r} ${r} 0 0 1 ${sx} ${sy}`;
	}
	const [sx, sy] = polar(cx, cy, r, from);
	const [ex, ey] = polar(cx, cy, r, from + sweep);
	return `M${sx} ${sy}A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${ex} ${ey}`;
}

export function esc(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

type TextOptions = {
	size: number;
	fill: string;
	weight?: number | "bold";
	anchor?: "start" | "middle" | "end";
	opacity?: number;
	spacing?: number;
	/** Draw a soft dark copy underneath for legibility on bright backgrounds. */
	shadow?: boolean;
	/** Content is pre-built markup (e.g. from `percentText`) and must not be escaped. */
	raw?: boolean;
};

export function text(x: number, y: number, content: string, o: TextOptions): string {
	const attrs = [
		`font-family="${FONT}"`,
		`font-size="${o.size}"`,
		o.weight ? `font-weight="${o.weight}"` : "",
		`text-anchor="${o.anchor ?? "middle"}"`,
		o.spacing ? `letter-spacing="${o.spacing}"` : "",
	]
		.filter(Boolean)
		.join(" ");
	const body = o.raw ? content : esc(content);
	const shadow = o.shadow ? `<text x="${r1(x)}" y="${r1(y + 1.6)}" ${attrs} fill="#000" fill-opacity="0.45">${body}</text>` : "";
	const opacity = o.opacity !== undefined && o.opacity < 1 ? ` fill-opacity="${o.opacity}"` : "";
	return `${shadow}<text x="${r1(x)}" y="${r1(y)}" ${attrs} fill="${o.fill}"${opacity}>${body}</text>`;
}

/** Big number with a smaller "%" sign on the same baseline. */
export function percentText(value: string, size: number): string {
	return `${esc(value)}<tspan font-size="${Math.round(size * 0.5)}" font-weight="bold">%</tspan>`;
}

export function svgDoc(width: number, height: number, body: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

export function toDataUrl(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
