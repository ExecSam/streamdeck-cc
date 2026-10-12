import { action } from "@elgato/streamdeck";

import { GAUGE_STYLES, type GaugeStyle, type KeySettings } from "../core/settings.js";
import { rotate, UsageAction } from "./usage-action.js";

/** One limit (session, weekly, per-model or "closest to the limit") as a live gauge. */
@action({ UUID: "com.execsam.claude-usage.gauge" })
export class GaugeAction extends UsageAction {
	protected override readonly kind = "gauge" as const;
	protected override readonly defaults = { press: "refresh", longPress: "cycle" } as const;

	protected override cycle(_action: unknown, settings: KeySettings, step: number): KeySettings {
		const ids = this.windowIds();
		if (ids.length === 0) return settings;
		const options = [...ids, "auto"];
		const current = settings.metric || "five_hour";
		return { ...settings, metric: rotate(options, options.includes(current) ? current : undefined, step) };
	}

	protected override nextStyle(settings: KeySettings, step: number): KeySettings {
		const current = (settings.style as GaugeStyle | undefined) ?? "ring";
		return { ...settings, style: rotate(GAUGE_STYLES, current, step) };
	}
}
