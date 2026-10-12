import { action } from "@elgato/streamdeck";

import { type KeySettings, OVERVIEW_STYLES, type OverviewStyle } from "../core/settings.js";
import { rotate, UsageAction } from "./usage-action.js";

/** Every limit at a glance. On a Stream Deck + dial, rotating moves the focus between limits. */
@action({ UUID: "com.execsam.claude-usage.overview" })
export class OverviewAction extends UsageAction {
	protected override readonly kind = "overview" as const;
	protected override readonly defaults = { press: "refresh", longPress: "cycle" } as const;

	protected override cycle(action: { isDial(): boolean }, settings: KeySettings, step: number): KeySettings {
		if (!action.isDial()) return this.nextStyle(settings, step);
		const ids = this.windowIds();
		if (ids.length === 0) return settings;
		return { ...settings, focus: rotate(ids, settings.focus && ids.includes(settings.focus) ? settings.focus : ids[0], step) };
	}

	protected override nextStyle(settings: KeySettings, step: number): KeySettings {
		const current = (settings.style as OverviewStyle | undefined) ?? "bars";
		return { ...settings, style: rotate(OVERVIEW_STYLES, current, step) };
	}
}
