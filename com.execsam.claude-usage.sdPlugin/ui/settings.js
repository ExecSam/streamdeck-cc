/* Claude Usage Meter: property inspector.
 *
 * Talks to Stream Deck over its WebSocket. Per-key settings are saved directly with setSettings;
 * account and appearance changes go to the plugin (sendToPlugin), which owns the global settings
 * and replies with a "state" message that this page renders.
 */
(() => {
	"use strict";

	const $ = (id) => document.getElementById(id);
	const GAUGE = "com.execsam.claude-usage.gauge";

	let ws;
	let uuid;
	let actionInfo = { action: GAUGE, payload: { settings: {} } };
	let settings = {};
	let state = null;
	let showSetup = false;
	let connecting = false;

	/* ---------------------------------------------------------------------------------------------
	 * Stream Deck connection
	 * ------------------------------------------------------------------------------------------- */

	window.connectElgatoStreamDeckSocket = (port, piUUID, registerEvent, info, actionInfoJson) => {
		uuid = piUUID;
		try {
			actionInfo = JSON.parse(actionInfoJson);
			settings = actionInfo.payload.settings || {};
		} catch {
			// Keep defaults.
		}
		try {
			const platform = JSON.parse(info).application.platform;
			document.body.classList.add(platform === "mac" ? "is-mac" : "is-win");
		} catch {
			document.body.classList.add(navigator.platform.startsWith("Mac") ? "is-mac" : "is-win");
		}

		ws = new WebSocket(`ws://127.0.0.1:${port}`);
		ws.onopen = () => {
			send({ event: registerEvent, uuid });
			toPlugin({ type: "hello" });
		};
		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.event === "didReceiveSettings") {
				settings = msg.payload.settings || {};
				renderKey();
			} else if (msg.event === "sendToPropertyInspector") {
				onPluginMessage(msg.payload);
			}
		};
		renderKey();
	};

	function send(obj) {
		if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
	}

	function toPlugin(payload) {
		send({ action: actionInfo.action, event: "sendToPlugin", context: uuid, payload });
	}

	function saveSettings(patch) {
		settings = { ...settings, ...patch };
		send({ event: "setSettings", context: uuid, payload: settings });
		renderKey();
	}

	function openUrl(url) {
		send({ event: "openUrl", payload: { url } });
	}

	function onPluginMessage(msg) {
		if (!msg || !msg.type) return;
		if (msg.type === "state") {
			state = msg;
			render();
		} else if (msg.type === "preview") {
			$("previewImg").src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(msg.svg)}`;
		} else if (msg.type === "connectResult") {
			connecting = false;
			$("connect").disabled = false;
			$("useClaudeCode").disabled = false;
			const el = $("connectResult");
			el.textContent = msg.ok ? `✓ ${msg.message}` : msg.message;
			el.className = `result ${msg.ok ? "ok" : "bad"}`;
			if (msg.ok) {
				$("paste").value = "";
				showSetup = false;
				render();
			}
		}
	}

	/* ---------------------------------------------------------------------------------------------
	 * Rendering
	 * ------------------------------------------------------------------------------------------- */

	function render() {
		renderStatus();
		renderBanner();
		renderSetup();
		renderUsage();
		renderKey();
		renderPrefs();
		renderAccount();
	}

	function renderStatus() {
		const el = $("status");
		const text = $("statusText");
		const sub = $("statusSub");
		$("version").textContent = state ? `v${state.version}` : "";
		el.className = "status";
		if (!state || !state.ready) {
			text.textContent = "Starting…";
			sub.textContent = "";
			return;
		}
		if (!state.configured) {
			el.classList.add("warn");
			text.textContent = "Not connected";
			sub.textContent = "Follow the steps below — it takes about a minute.";
			return;
		}
		if (state.fetching) el.classList.add("busy");
		if (state.error && state.windows.length === 0) {
			el.classList.add("bad");
			text.textContent = errorTitle(state.error.kind);
		} else if (state.error) {
			el.classList.add("warn");
			text.textContent = "Connected · showing last known usage";
		} else {
			el.classList.add("ok");
			text.textContent = ["Connected", state.plan].filter(Boolean).join(" · ");
		}
		sub.textContent = [state.orgName, updatedText()].filter(Boolean).join(" · ");
	}

	function updatedText() {
		if (!state) return "";
		if (state.fetching) return "updating…";
		if (!state.lastSuccess) return "";
		return `updated ${ago(state.lastSuccess)}`;
	}

	function errorTitle(kind) {
		return (
			{
				auth: "Session expired",
				cloudflare: "Blocked by Cloudflare",
				network: "Offline",
				rate_limit: "Rate limited",
				no_org: "No organization",
				not_configured: "Not connected",
			}[kind] || "Something went wrong"
		);
	}

	function renderBanner() {
		const banner = $("banner");
		const actions = $("bannerActions");
		actions.innerHTML = "";
		if (!state || !state.error || !state.configured) {
			banner.hidden = true;
			return;
		}
		const { kind, message } = state.error;
		banner.hidden = false;
		banner.className = `banner ${kind === "network" || kind === "rate_limit" || kind === "server" ? "warn" : ""}`;
		$("bannerText").textContent = message;
		if (kind === "auth" && state.source === "cookie") {
			actions.append(button("Paste a fresh cookie", () => openSetup(), "btn small primary"));
		}
		if (kind === "cloudflare") {
			actions.append(button("Paste a fresh cURL", () => openSetup(), "btn small primary"));
			if (!state.prefs.claudeCodeFallback) {
				actions.append(button("Use Claude Code fallback", () => toPlugin({ type: "prefs", prefs: { claudeCodeFallback: true } })));
			}
		}
		actions.append(button("Try again", () => refreshNow()));
	}

	function renderSetup() {
		const visible = !!state && state.ready && (!state.configured || showSetup);
		$("setup").hidden = !visible;
		$("setupClose").hidden = !(state && state.configured);
	}

	function openSetup() {
		showSetup = true;
		$("connectResult").textContent = "";
		render();
		$("setup").scrollIntoView({ behavior: "smooth", block: "start" });
		$("paste").focus();
	}

	function renderUsage() {
		const card = $("usage");
		if (!state || !state.configured || state.windows.length === 0) {
			card.hidden = true;
			return;
		}
		card.hidden = false;
		$("refresh").classList.toggle("spin", !!state.fetching);

		const now = Date.now();
		const list = $("windows");
		list.innerHTML = "";
		for (const w of state.windows) {
			const row = el("div", "win");
			const head = el("div", "win-head");
			head.append(el("span", "win-label", w.label));
			const pct = el("span", "win-pct", `${formatPercent(w.percent)}%`);
			pct.style.color = w.color;
			head.append(pct);

			const bar = el("div", "bar");
			const fill = el("div", "fill");
			fill.style.width = `${Math.max(0, Math.min(100, w.percent))}%`;
			fill.style.background = w.color;
			bar.append(fill);
			const elapsed = elapsedNow(w, now);
			if (elapsed !== null) {
				const tick = el("div", "pace");
				tick.style.left = `${elapsed * 100}%`;
				tick.title = "Even pace: where usage would be if spread evenly over the window";
				bar.append(tick);
			}

			const meta = el("div", "win-meta");
			meta.append(paceLine(w, now));
			meta.append(el("span", "", w.resetsAt ? `resets in ${duration(w.resetsAt - now)} · ${clock(w.resetsAt)}` : "starts with your next message"));

			row.append(head, bar, meta);
			list.append(row);
		}

		const extra = $("extra");
		const x = state.extra;
		if (x && (x.enabled || x.usedMinor > 0)) {
			extra.hidden = false;
			const used = money(x.usedMinor, x.currency);
			extra.textContent = x.limitMinor > 0 ? `Extra usage: ${used} of ${money(x.limitMinor, x.currency)} this month` : `Extra usage: ${used} this month`;
		} else {
			extra.hidden = true;
		}
	}

	function paceLine(w, now) {
		const span = el("span", "");
		const p = w.projection;
		if (!p || elapsedNow(w, now) === null) {
			span.textContent = w.percent >= 100 ? "Limit reached" : "";
			if (w.percent >= 100) span.className = "danger";
			return span;
		}
		if (w.percent >= 100) {
			span.textContent = "Limit reached";
			span.className = "danger";
		} else if (p.limitAt) {
			span.textContent = `⚠ at this pace, limit in ~${duration(p.limitAt - now)}`;
			span.className = "danger";
		} else if (p.paceRatio > 1.15) {
			span.textContent = `running ${p.paceRatio.toFixed(1)}× faster than even`;
			span.className = "hot";
		} else {
			span.textContent = "on track ✓";
			span.className = "cool";
		}
		return span;
	}

	function elapsedNow(w, now) {
		if (!w.resetsAt || !w.windowMs) return null;
		return Math.max(0, Math.min(1, 1 - (w.resetsAt - now) / w.windowMs));
	}

	/* --------------------------------- per-key settings ---------------------------------------- */

	const STYLE_ICONS = {
		ring: '<path d="M6.3 17.7a8 8 0 1 1 11.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M6.3 17.7a8 8 0 0 1 5.7-13.7" fill="none" stroke="#d97757" stroke-width="2.4" stroke-linecap="round"/>',
		liquid: '<rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 13q2-1.5 4 0t4 0t4 0t4 0V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="#d97757"/>',
		number: '<text x="12" y="15.5" font-size="10" font-weight="700" text-anchor="middle" fill="currentColor" font-family="sans-serif">42</text><rect x="4" y="18" width="16" height="2.4" rx="1.2" fill="currentColor" opacity=".3"/><rect x="4" y="18" width="7" height="2.4" rx="1.2" fill="#d97757"/>',
		countdown: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.2" opacity=".35"/><path d="M12 4a8 8 0 1 1-8 8" fill="none" stroke="#d97757" stroke-width="2.2" stroke-linecap="round"/><path d="M12 8v4l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
		bars: '<rect x="3" y="5" width="18" height="3" rx="1.5" fill="currentColor" opacity=".3"/><rect x="3" y="5" width="10" height="3" rx="1.5" fill="#d97757"/><rect x="3" y="11" width="18" height="3" rx="1.5" fill="currentColor" opacity=".3"/><rect x="3" y="11" width="14" height="3" rx="1.5" fill="#fbbf24"/><rect x="3" y="17" width="18" height="3" rx="1.5" fill="currentColor" opacity=".3"/><rect x="3" y="17" width="5" height="3" rx="1.5" fill="#34d399"/>',
		dual: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" opacity=".3"/><path d="M12 3a9 9 0 0 1 8.6 11.7" fill="none" stroke="#d97757" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-width="2" opacity=".3"/><path d="M12 6.5a5.5 5.5 0 1 1-5.5 5.5" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>',
	};

	function renderKey() {
		const isGauge = actionInfo.action === GAUGE;
		const isDial = actionInfo.payload && actionInfo.payload.controller === "Encoder";
		$("keyTitle").textContent = isDial ? "This dial" : "This key";
		$("preview").classList.toggle("dial", !!isDial);

		// Metric
		$("metricField").hidden = !isGauge;
		if (isGauge) {
			const select = $("metric");
			const windows = state && state.windows.length ? state.windows : [
				{ id: "five_hour", label: "Session (5h)" },
				{ id: "seven_day", label: "Weekly (all models)" },
			];
			const options = [...windows.map((w) => [w.id, w.label]), ["auto", "Auto — whichever is closest to its limit"]];
			const current = settings.metric || "five_hour";
			if (!options.some(([id]) => id === current)) options.push([current, `${current} (not reported right now)`]);
			fillSelect(select, options, current);
		}

		// Style
		const styles = isGauge
			? [
					["ring", "Ring"],
					["liquid", "Liquid"],
					["number", "Number"],
					["countdown", "Timer"],
				]
			: [
					["bars", "Bars"],
					["dual", "Dual ring"],
				];
		const currentStyle = settings.style || styles[0][0];
		const seg = $("style");
		seg.innerHTML = "";
		seg.closest(".field").hidden = !!isDial;
		for (const [id, label] of styles) {
			const b = document.createElement("button");
			b.type = "button";
			b.setAttribute("aria-pressed", String(id === currentStyle));
			b.innerHTML = `<svg viewBox="0 0 24 24">${STYLE_ICONS[id]}</svg><span>${label}</span>`;
			b.onclick = () => saveSettings({ style: id });
			seg.append(b);
		}

		// Tap / hold
		$("keyControls").hidden = !!isDial;
		$("dialHelp").hidden = !isDial;
		const actions = [
			["refresh", "Refresh now"],
			["cycle", isGauge ? "Next limit" : "Next style"],
			...(isGauge ? [["style", "Next style"]] : []),
			["open", "Open claude.ai usage page"],
			["none", "Do nothing"],
		];
		fillSelect($("press"), actions, settings.press || "refresh");
		fillSelect($("longPress"), actions, settings.longPress || "cycle");

		$("showPace").checked = settings.showPace !== false;
	}

	/* --------------------------------- global preferences -------------------------------------- */

	function renderPrefs() {
		if (!state) return;
		const p = state.prefs;
		const themes = $("themes");
		themes.innerHTML = "";
		for (const t of state.themes) {
			const b = document.createElement("button");
			b.type = "button";
			b.setAttribute("aria-pressed", String(t.id === p.theme));
			b.innerHTML = `<span class="swatch" style="background:linear-gradient(90deg,${t.stops.join(",")})"></span>${t.label}`;
			b.onclick = () => setPrefs({ theme: t.id });
			themes.append(b);
		}
		if (document.activeElement !== $("warnAt")) $("warnAt").value = p.warnAt;
		if (document.activeElement !== $("critAt")) $("critAt").value = p.critAt;
		$("warnAtOut").textContent = `${p.warnAt}%`;
		$("critAtOut").textContent = `${p.critAt}%`;
		$("pulse").checked = p.pulse;
		$("animate").checked = p.animate;
		$("pollSeconds").value = String(p.pollSeconds);
		$("claudeCodeFallback").checked = p.claudeCodeFallback;

		const theme = state.themes.find((t) => t.id === p.theme) || state.themes[0];
		const [ok, warn, crit, max] = theme.stops;
		$("gradient").style.background =
			p.theme === "mono"
				? `linear-gradient(90deg, ${ok} 0%, ${ok} ${p.critAt}%, ${crit} ${p.critAt}%, ${max} 100%)`
				: `linear-gradient(90deg, ${ok} 0%, ${warn} ${p.warnAt}%, ${crit} ${p.critAt}%, ${max} 100%)`;
	}

	function setPrefs(patch) {
		if (state) state.prefs = { ...state.prefs, ...patch };
		renderPrefs();
		toPlugin({ type: "prefs", prefs: patch });
	}

	function renderAccount() {
		const card = $("account");
		if (!state || !state.configured) {
			card.hidden = true;
			return;
		}
		card.hidden = false;
		const line = $("accountLine");
		line.innerHTML = "";
		if (state.source === "claude-code") {
			line.append(el("span", "", "Reading usage through your Claude Code login."));
			$("replace").textContent = "Use a browser cookie instead";
			$("fallbackRow").hidden = true;
		} else {
			line.append(el("span", "", "Browser session cookie"));
			if (state.cookieHint) line.append(el("code", "", state.cookieHint));
			$("replace").textContent = "Replace cookie";
			$("fallbackRow").hidden = false;
		}
		if (state.dataSource === "claude-code" && state.source === "cookie") {
			line.append(el("span", "muted", "Latest numbers came from the Claude Code fallback."));
		}
	}

	/* ---------------------------------------------------------------------------------------------
	 * Wiring
	 * ------------------------------------------------------------------------------------------- */

	function refreshNow() {
		$("refresh").classList.add("spin");
		toPlugin({ type: "refresh" });
	}

	function wire() {
		document.querySelectorAll("#browserTabs button").forEach((tab) => {
			tab.onclick = () => selectBrowser(tab.dataset.browser);
		});
		selectBrowser("chromium");

		$("openUsage").onclick = () => openUrl("https://claude.ai/settings/usage");
		$("reveal").onclick = () => {
			const masked = $("paste").classList.toggle("masked");
			$("reveal").textContent = masked ? "Show" : "Hide";
		};
		$("paste").addEventListener("paste", () => setResult(""));
		$("paste").addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) connect();
		});
		$("connect").onclick = connect;
		$("useClaudeCode").onclick = () => {
			connecting = true;
			$("useClaudeCode").disabled = true;
			setResult("Reading your Claude Code login…");
			toPlugin({ type: "useClaudeCode" });
		};
		$("setupClose").onclick = () => {
			showSetup = false;
			render();
		};

		$("refresh").onclick = refreshNow;
		$("replace").onclick = openSetup;
		$("disconnect").onclick = () => {
			if (confirm("Disconnect and forget the stored cookie?")) toPlugin({ type: "disconnect" });
		};

		$("metric").onchange = (e) => saveSettings({ metric: e.target.value });
		$("press").onchange = (e) => saveSettings({ press: e.target.value });
		$("longPress").onchange = (e) => saveSettings({ longPress: e.target.value });
		$("showPace").onchange = (e) => saveSettings({ showPace: e.target.checked });

		for (const id of ["warnAt", "critAt"]) {
			$(id).oninput = (e) => ($(`${id}Out`).textContent = `${e.target.value}%`);
			$(id).onchange = (e) => {
				let warnAt = Number($("warnAt").value);
				let critAt = Number($("critAt").value);
				if (critAt <= warnAt) {
					if (id === "warnAt") critAt = Math.min(100, warnAt + 5);
					else warnAt = Math.max(5, critAt - 5);
				}
				setPrefs({ warnAt, critAt });
				e.target.blur();
			};
		}
		$("pulse").onchange = (e) => setPrefs({ pulse: e.target.checked });
		$("animate").onchange = (e) => setPrefs({ animate: e.target.checked });
		$("pollSeconds").onchange = (e) => setPrefs({ pollSeconds: Number(e.target.value) });
		$("claudeCodeFallback").onchange = (e) => setPrefs({ claudeCodeFallback: e.target.checked });

		document.querySelectorAll("[data-url]").forEach((a) => {
			a.onclick = (e) => {
				e.preventDefault();
				openUrl(a.dataset.url);
			};
		});

		// Keep "updated 12s ago" and countdowns fresh.
		setInterval(() => {
			if (!state) return;
			renderStatus();
			renderUsage();
		}, 1000);
	}

	function connect() {
		const raw = $("paste").value.trim();
		if (!raw) {
			setResult("Paste your cookie or cURL first.", "bad");
			return;
		}
		connecting = true;
		$("connect").disabled = true;
		setResult("Checking with claude.ai…");
		toPlugin({ type: "connect", raw });
	}

	function setResult(text, kind = "") {
		const el = $("connectResult");
		el.textContent = text;
		el.className = `result ${kind}`;
	}

	function selectBrowser(browser) {
		document.querySelectorAll("#browserTabs button").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.browser === browser)));
		document.querySelectorAll("[data-only]").forEach((node) => (node.hidden = node.dataset.only !== browser));
	}

	/* ---------------------------------------------------------------------------------------------
	 * Helpers
	 * ------------------------------------------------------------------------------------------- */

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function button(label, onClick, className = "btn small") {
		const b = el("button", className, label);
		b.type = "button";
		b.onclick = onClick;
		return b;
	}

	function fillSelect(select, options, value) {
		select.innerHTML = "";
		for (const [id, label] of options) {
			const opt = document.createElement("option");
			opt.value = id;
			opt.textContent = label;
			select.append(opt);
		}
		select.value = value;
	}

	function formatPercent(p) {
		const r = Math.round(p);
		return r >= 100 && p < 100 ? "99" : String(Math.max(0, r));
	}

	function duration(ms) {
		if (ms <= 0) return "now";
		const m = Math.floor(ms / 60000);
		const d = Math.floor(m / 1440);
		const h = Math.floor((m % 1440) / 60);
		if (d) return h ? `${d}d ${h}h` : `${d}d`;
		if (h) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
		if (m) return `${m}m`;
		return `${Math.max(1, Math.floor(ms / 1000))}s`;
	}

	function ago(ts) {
		const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
		if (s < 5) return "just now";
		if (s < 60) return `${s}s ago`;
		return `${duration(s * 1000)} ago`;
	}

	function clock(ts) {
		const d = new Date(ts);
		const sameDay = d.toDateString() === new Date().toDateString();
		const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
		return sameDay ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
	}

	function money(minor, currency) {
		try {
			return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
		} catch {
			return `${(minor / 100).toFixed(2)} ${currency}`;
		}
	}

	wire();
})();
