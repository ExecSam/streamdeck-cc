/**
 * Keeps every visible key / dial in sync with the usage store and drives the animations:
 *
 *  - values ease toward new numbers after each refresh (and sweep up from 0 on a key press)
 *  - a spinner runs while a refresh you asked for is in flight
 *  - the glow breathes when a limit is past the critical threshold
 *  - countdowns tick over without refetching
 *
 * One timer serves all views. It runs fast only while something is moving, and an image is only sent
 * to Stream Deck when the rendered SVG actually changed.
 */

import type { GaugeStyle, KeySettings, OverviewStyle, Prefs } from "./core/settings.js";
import type { StoreState, UsageStore } from "./core/store.js";
import { type LimitWindow, mostConstrained, pickWindow } from "./core/usage.js";
import { type Frame, type MessageKind, renderGauge, renderMessage, renderOverview, renderStrip } from "./render/keys.js";
import { toDataUrl } from "./render/svg.js";

export type ViewKind = "gauge" | "overview";

/** Where a view draws: a key (setImage) or a dial's touch strip (setFeedback). */
export type Surface = {
	readonly id: string;
	readonly isDial: boolean;
	draw(dataUrl: string): Promise<void>;
};

const ANIM_MS = 750;
const SPIN_MIN_MS = 650;
const PULSE_PERIOD_MS = 1800;

type View = {
	surface: Surface;
	kind: ViewKind;
	settings: KeySettings;
	displayed: Map<string, number>;
	from: Map<string, number>;
	animStart: number;
	animating: boolean;
	spinUntil: number;
	/** Sweep the value up from zero once the refresh spinner stops. */
	pendingSweep: boolean;
	lastSvg: string;
};

export type PresenterOptions = {
	now?: () => number;
	/** Receives the latest SVG of a view, e.g. to mirror it in the property inspector. */
	onRender?: (viewId: string, svg: string) => void;
};

export class Presenter {
	readonly #store: UsageStore;
	readonly #views = new Map<string, View>();
	readonly #now: () => number;
	readonly #onRender?: (viewId: string, svg: string) => void;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#lastFetchedAt: number | null = null;
	#unsubscribe: () => void;

	constructor(store: UsageStore, options: PresenterOptions = {}) {
		this.#store = store;
		this.#now = options.now ?? (() => Date.now());
		this.#onRender = options.onRender;
		this.#unsubscribe = store.subscribe(() => this.#onStoreChange());
	}

	get size(): number {
		return this.#views.size;
	}

	add(surface: Surface, kind: ViewKind, settings: KeySettings): void {
		const view: View = {
			surface,
			kind,
			settings: { ...settings },
			displayed: new Map(),
			from: new Map(),
			animStart: 0,
			animating: false,
			spinUntil: 0,
			pendingSweep: false,
			lastSvg: "",
		};
		this.#views.set(surface.id, view);
		const snapshot = this.#store.state.snapshot;
		if (snapshot) this.#animate(view, snapshot.windows, true);
		this.kick();
	}

	remove(id: string): void {
		this.#views.delete(id);
	}

	updateSettings(id: string, settings: KeySettings): void {
		const view = this.#views.get(id);
		if (!view) return;
		const metricChanged = view.settings.metric !== settings.metric || view.settings.focus !== settings.focus;
		view.settings = { ...settings };
		const snapshot = this.#store.state.snapshot;
		if (metricChanged && snapshot) this.#animate(view, snapshot.windows, true);
		this.kick();
	}

	/** A key was pressed to refresh: spin for at least a beat, then sweep the value up. */
	markManualRefresh(id: string): void {
		const view = this.#views.get(id);
		if (!view) return;
		view.spinUntil = this.#now() + SPIN_MIN_MS;
		view.pendingSweep = true;
		this.kick();
	}

	/** Last SVG drawn for a view (used to seed the property inspector preview). */
	lastSvg(id: string): string | undefined {
		return this.#views.get(id)?.lastSvg || undefined;
	}

	/** Render now (and reschedule the loop). */
	kick(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#tick(), 0);
	}

	dispose(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#unsubscribe();
		this.#views.clear();
	}

	/* -------------------------------------------------------------------------------------------- */

	#onStoreChange(): void {
		const snapshot = this.#store.state.snapshot;
		if (snapshot && snapshot.fetchedAt !== this.#lastFetchedAt) {
			this.#lastFetchedAt = snapshot.fetchedAt;
			for (const view of this.#views.values()) this.#animate(view, snapshot.windows, false);
		}
		if (!snapshot) this.#lastFetchedAt = null;
		this.kick();
	}

	#animate(view: View, windows: readonly LimitWindow[], fromZero: boolean): void {
		const from = new Map<string, number>();
		let changed = false;
		for (const w of windows) {
			const current = fromZero ? 0 : (view.displayed.get(w.id) ?? 0);
			from.set(w.id, current);
			if (Math.abs(current - w.percent) > 0.05) changed = true;
		}
		view.from = from;
		view.animStart = this.#now();
		view.animating = changed && this.#store.prefs.animate;
	}

	#tick(): void {
		this.#timer = undefined;
		const now = this.#now();
		const state = this.#store.state;
		let fastest = 1000;

		for (const view of this.#views.values()) {
			const { svg, interval } = this.#renderView(view, state, now);
			fastest = Math.min(fastest, interval);
			if (svg !== view.lastSvg) {
				view.lastSvg = svg;
				view.surface.draw(toDataUrl(svg)).catch(() => {
					// The action may have just disappeared; the next tick will sort itself out.
				});
				this.#onRender?.(view.surface.id, svg);
			}
		}

		if (this.#views.size > 0) {
			this.#timer = setTimeout(() => this.#tick(), fastest);
			this.#timer.unref?.();
		}
	}

	/** Builds the SVG for a view and says how soon it needs redrawing. */
	#renderView(view: View, state: StoreState, now: number): { svg: string; interval: number } {
		const prefs = state.prefs;
		const spinning = state.manual || now < view.spinUntil || (state.fetching && !state.snapshot);
		const spin = spinning ? ((now % 900) / 900) * 360 : null;
		const size = view.surface.isDial ? { w: 200, h: 100 } : undefined;
		const base: Frame = { now, prefs, spin, showPace: view.settings.showPace !== false };

		const message = this.#messageFor(state);
		if (message) {
			const svg = renderMessage(message, base, size);
			return { svg, interval: spin !== null ? 60 : 1000 };
		}

		const snapshot = state.snapshot!;
		if (!spinning && view.pendingSweep) {
			view.pendingSweep = false;
			this.#animate(view, snapshot.windows, true);
		}
		const windows = snapshot.windows.map((w) => ({ ...w, percent: this.#displayed(view, w, now, spinning) }));
		const animating = view.animating;

		const focusPct =
			view.kind === "gauge" ? (pickWindow({ ...snapshot, windows }, metricOf(view))?.percent ?? 0) : (mostConstrained(windows)?.percent ?? 0);
		const pulsing = prefs.pulse && focusPct >= prefs.critAt && !spinning;
		const pulse = pulsing ? 0.5 - 0.5 * Math.cos((2 * Math.PI * (now % PULSE_PERIOD_MS)) / PULSE_PERIOD_MS) : 0;

		const frame: Frame = {
			...base,
			pulse: pulsing ? Math.round(pulse * 10) / 10 : 0,
			wave: animating || pulsing ? (now % 2400) / 2400 : 0.3,
			badge: state.error ? (state.error.kind === "auth" ? "error" : "warn") : null,
		};

		let svg: string;
		if (view.surface.isDial) {
			svg = renderStrip(windows, view.settings.focus, frame);
		} else if (view.kind === "gauge") {
			const w = pickWindow({ ...snapshot, windows }, metricOf(view))!;
			svg = renderGauge((view.settings.style as GaugeStyle) ?? "ring", w, frame);
		} else {
			svg = renderOverview((view.settings.style as OverviewStyle) ?? "bars", windows, frame);
		}

		const interval = spin !== null || animating ? 60 : pulsing ? 120 : 1000;
		return { svg, interval };
	}

	#displayed(view: View, w: LimitWindow, now: number, holding: boolean): number {
		let value = w.percent;
		if (holding) {
			// Freeze while the spinner runs; the sweep starts when it stops.
			value = view.displayed.get(w.id) ?? w.percent;
		} else if (view.animating) {
			const t = Math.min(1, (now - view.animStart) / ANIM_MS);
			const eased = 1 - (1 - t) ** 3;
			const from = view.from.get(w.id) ?? 0;
			value = from + (w.percent - from) * eased;
			if (t >= 1) view.animating = false;
		}
		view.displayed.set(w.id, value);
		return value;
	}

	#messageFor(state: StoreState): MessageKind | null {
		if (!state.ready) return "loading";
		if (!state.configured) return "setup";
		if (!state.snapshot) {
			if (state.fetching || !state.error) return "loading";
			switch (state.error.kind) {
				case "auth":
				case "cloudflare":
				case "network":
				case "rate_limit":
					return state.error.kind;
				case "not_configured":
					return "setup";
				default:
					return "error";
			}
		}
		if (state.snapshot.windows.length === 0) return "empty";
		return null;
	}
}

/** Gauges default to the 5-hour session limit — the one Claude Code users hit first. */
function metricOf(view: View): string {
	return view.settings.metric || "five_hour";
}

export type { Prefs };
