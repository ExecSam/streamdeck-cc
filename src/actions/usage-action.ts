import streamDeck, {
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	type PropertyInspectorDidAppearEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type KeySettings, type PressAction, USAGE_PAGE_URL } from "../core/settings.js";
import type { UsageStore } from "../core/store.js";
import type { Presenter, ViewKind } from "../presenter.js";

export type PluginContext = {
	store: UsageStore;
	presenter: Presenter;
	/** Call whenever the set of visible views changes. */
	viewsChanged(): void;
	/** Push the latest status + preview to the property inspector. */
	syncUi(): void;
};

const LONG_PRESS_MS = 550;

type AnyAction = KeyAction<KeySettings> | DialAction<KeySettings>;

/**
 * Behaviour shared by every usage action: registering with the presenter, press / long-press,
 * dial rotation and touch handling.
 */
export abstract class UsageAction extends SingletonAction<KeySettings> {
	protected abstract readonly kind: ViewKind;
	protected abstract readonly defaults: { press: PressAction; longPress: PressAction };
	readonly #holds = new Map<string, { timer: ReturnType<typeof setTimeout>; fired: boolean }>();

	constructor(protected readonly ctx: PluginContext) {
		super();
	}

	/** What "cycle" means for this action (next limit, next style, …). */
	protected abstract cycle(action: AnyAction, settings: KeySettings, step: number): KeySettings;

	override onWillAppear(ev: WillAppearEvent<KeySettings>): void {
		const action = ev.action;
		this.ctx.presenter.add(
			{
				id: action.id,
				isDial: action.isDial(),
				draw: (url) => (action.isDial() ? action.setFeedback({ canvas: url }) : action.setImage(url)),
			},
			this.kind,
			ev.payload.settings,
		);
		this.ctx.viewsChanged();
	}

	override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void {
		this.ctx.presenter.remove(ev.action.id);
		const hold = this.#holds.get(ev.action.id);
		if (hold) clearTimeout(hold.timer);
		this.#holds.delete(ev.action.id);
		this.ctx.viewsChanged();
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
		this.ctx.presenter.updateSettings(ev.action.id, ev.payload.settings);
	}

	override onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent<KeySettings>): void {
		this.ctx.syncUi();
	}

	/* ---------------------------------------------------------------------------------------------
	 * Keys: tap = press action, hold = long-press action
	 * ------------------------------------------------------------------------------------------- */

	override onKeyDown(ev: KeyDownEvent<KeySettings>): void {
		const id = ev.action.id;
		const existing = this.#holds.get(id);
		if (existing) clearTimeout(existing.timer);

		const hold = {
			fired: false,
			timer: setTimeout(() => {
				hold.fired = true;
				void this.perform(ev.action, ev.payload.settings, ev.payload.settings.longPress ?? this.defaults.longPress);
			}, LONG_PRESS_MS),
		};
		this.#holds.set(id, hold);
	}

	override onKeyUp(ev: KeyUpEvent<KeySettings>): void {
		const hold = this.#holds.get(ev.action.id);
		this.#holds.delete(ev.action.id);
		if (hold) clearTimeout(hold.timer);
		if (hold?.fired) return;
		void this.perform(ev.action, ev.payload.settings, ev.payload.settings.press ?? this.defaults.press);
	}

	/* ---------------------------------------------------------------------------------------------
	 * Dials: push / tap = refresh, rotate = cycle, long touch = open claude.ai
	 * ------------------------------------------------------------------------------------------- */

	override onDialDown(ev: DialDownEvent<KeySettings>): void {
		void this.perform(ev.action, ev.payload.settings, "refresh");
	}

	override onDialRotate(ev: DialRotateEvent<KeySettings>): void {
		void this.perform(ev.action, ev.payload.settings, "cycle", Math.sign(ev.payload.ticks) || 1);
	}

	override onTouchTap(ev: TouchTapEvent<KeySettings>): void {
		void this.perform(ev.action, ev.payload.settings, ev.payload.hold ? "open" : "refresh");
	}

	/* ------------------------------------------------------------------------------------------- */

	protected async perform(action: AnyAction, settings: KeySettings, what: PressAction, step = 1): Promise<void> {
		const { store, presenter } = this.ctx;

		// Not connected yet: every press takes you to step one of the setup guide.
		if (!store.configured && what !== "none") {
			await streamDeck.system.openUrl(USAGE_PAGE_URL);
			return;
		}

		switch (what) {
			case "refresh": {
				presenter.markManualRefresh(action.id);
				const ok = await store.refresh({ manual: true });
				if (!ok) await action.showAlert();
				return;
			}
			case "cycle":
			case "style": {
				const next = what === "cycle" ? this.cycle(action, settings, step) : this.nextStyle(settings, step);
				await action.setSettings(next);
				presenter.updateSettings(action.id, next);
				if (streamDeck.ui.action?.id === action.id) this.ctx.syncUi();
				return;
			}
			case "open":
				await streamDeck.system.openUrl(USAGE_PAGE_URL);
				return;
			default:
				return;
		}
	}

	protected abstract nextStyle(settings: KeySettings, step: number): KeySettings;

	/** Ids of the limits currently reported, in display order. */
	protected windowIds(): string[] {
		return this.ctx.store.state.snapshot?.windows.map((w) => w.id) ?? [];
	}
}

export function rotate<T>(list: readonly T[], current: T | undefined, step: number): T {
	if (list.length === 0) throw new Error("empty list");
	const idx = current === undefined ? -1 : list.indexOf(current);
	const base = idx < 0 ? (step > 0 ? -1 : 0) : idx;
	return list[(((base + step) % list.length) + list.length) % list.length];
}
