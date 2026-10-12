import streamDeck from "@elgato/streamdeck";

import { GaugeAction } from "./actions/gauge.js";
import { OverviewAction } from "./actions/overview.js";
import type { PluginContext } from "./actions/usage-action.js";
import { maskSessionKey } from "./core/credentials.js";
import { DEFAULT_PREFS, type GlobalSettings, type Prefs } from "./core/settings.js";
import { UsageStore } from "./core/store.js";
import { elapsedFraction, project } from "./core/usage.js";
import { Presenter } from "./presenter.js";
import { THEMES, usageColor } from "./render/theme.js";
import { VERSION } from "./version.js";

streamDeck.logger.setLevel("info");

const store = new UsageStore({
	load: () => streamDeck.settings.getGlobalSettings<GlobalSettings>(),
	save: (settings) => streamDeck.settings.setGlobalSettings(settings),
	log: (level, message) => streamDeck.logger[level](message),
});

/* ------------------------------------------------------------------------------------------------
 * Property inspector bridge
 * ---------------------------------------------------------------------------------------------- */

let lastStateJson = "";
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPreview: string | undefined;

function publicState() {
	const s = store.state;
	const now = Date.now();
	return {
		type: "state",
		version: VERSION,
		ready: s.ready,
		configured: s.configured,
		source: s.source,
		dataSource: s.snapshot?.source ?? null,
		orgName: s.orgName ?? null,
		plan: s.plan ?? null,
		cookieHint: maskSessionKey(store.settings.cookie) ?? null,
		fetching: s.fetching,
		lastSuccess: s.lastSuccess,
		lastAttempt: s.lastAttempt,
		error: s.error ? { kind: s.error.kind, message: s.error.message } : null,
		windows:
			s.snapshot?.windows.map((w) => ({
				id: w.id,
				label: w.label,
				short: w.short,
				percent: w.percent,
				resetsAt: w.resetsAt,
				windowMs: w.windowMs,
				color: usageColor(w.percent, s.prefs),
				elapsed: elapsedFraction(w, now),
				projection: project(w, now),
			})) ?? [],
		extra: s.snapshot?.extra ?? null,
		prefs: s.prefs,
		themes: Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label, stops: [...t.stops] })),
	};
}

function syncUi(force = false): void {
	const current = streamDeck.ui.action;
	if (!current) return;
	const state = publicState();
	const json = JSON.stringify(state);
	if (force || json !== lastStateJson) {
		lastStateJson = json;
		void streamDeck.ui.sendToPropertyInspector(state);
	}
	const svg = presenter.lastSvg(current.id);
	if (force && svg) void streamDeck.ui.sendToPropertyInspector({ type: "preview", svg });
}

/** Mirror the open key's artwork into the property inspector, at most ~6 times a second. */
function queuePreview(svg: string): void {
	pendingPreview = svg;
	if (previewTimer) return;
	previewTimer = setTimeout(() => {
		previewTimer = undefined;
		if (pendingPreview && streamDeck.ui.action) {
			void streamDeck.ui.sendToPropertyInspector({ type: "preview", svg: pendingPreview });
		}
		pendingPreview = undefined;
	}, 160);
}

const presenter = new Presenter(store, {
	onRender: (id, svg) => {
		if (streamDeck.ui.action?.id === id) queuePreview(svg);
	},
});

const ctx: PluginContext = {
	store,
	presenter,
	viewsChanged: () => store.setViewCount(presenter.size),
	syncUi: () => syncUi(true),
};

type UiMessage =
	| { type: "hello" }
	| { type: "connect"; raw: string }
	| { type: "useClaudeCode" }
	| { type: "disconnect" }
	| { type: "refresh" }
	| { type: "prefs"; prefs: Partial<Prefs> };

streamDeck.ui.onSendToPlugin<UiMessage>(async (ev) => {
	const msg = ev.payload;
	if (!msg || typeof msg !== "object" || !("type" in msg)) return;

	switch (msg.type) {
		case "hello":
			syncUi(true);
			break;
		case "connect": {
			const result = await store.connect(String(msg.raw ?? ""));
			await streamDeck.ui.sendToPropertyInspector({ type: "connectResult", ...result });
			syncUi(true);
			break;
		}
		case "useClaudeCode": {
			const result = await store.useClaudeCode();
			await streamDeck.ui.sendToPropertyInspector({ type: "connectResult", ...result });
			syncUi(true);
			break;
		}
		case "disconnect":
			await store.disconnect();
			syncUi(true);
			break;
		case "refresh":
			presenter.markManualRefresh(ev.action.id);
			await store.refresh({ manual: true });
			break;
		case "prefs":
			await store.updatePrefs(pickPrefs(msg.prefs));
			break;
	}
});

/** Only accept known preference keys from the UI; `resolvePrefs` validates the values. */
function pickPrefs(input: unknown): Partial<Prefs> {
	if (!input || typeof input !== "object") return {};
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(DEFAULT_PREFS)) {
		if (key in input) out[key] = (input as Record<string, unknown>)[key];
	}
	return out as Partial<Prefs>;
}

store.subscribe(() => syncUi());
streamDeck.system.onSystemDidWakeUp(() => {
	if (presenter.size > 0) void store.refresh();
});

streamDeck.actions.registerAction(new GaugeAction(ctx));
streamDeck.actions.registerAction(new OverviewAction(ctx));

await streamDeck.connect();
await store.init();
ctx.viewsChanged();
streamDeck.logger.info(`Claude Usage Meter ${VERSION} ready`);
