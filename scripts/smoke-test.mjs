/**
 * End-to-end smoke test: pretends to be the Stream Deck app, launches the built plugin over the real
 * WebSocket protocol (with a fake claude.ai), and walks through setup → connect → refresh → dial.
 *
 *   npm run build && npm run smoke [-- <dir to save rendered frames>]
 */

import { Resvg } from "@resvg/resvg-js";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";

const root = resolve(import.meta.dirname, "..");
const pluginDir = join(root, "com.execsam.claude-usage.sdPlugin");
const saveDir = process.argv[2];
if (saveDir) mkdirSync(saveDir, { recursive: true });

const KEY = "com.execsam.claude-usage.gauge";
const OVERVIEW = "com.execsam.claude-usage.overview";
const SESSION = "sk-ant-sid01-smoketestsmoketestsmoketest";

const received = [];
const waiters = [];
let globals = {};
let socket;

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.once("listening", r));
const port = wss.address().port;

wss.on("connection", (ws) => {
	socket = ws;
	ws.on("message", (data) => {
		const msg = JSON.parse(String(data));
		if (msg.event === "getGlobalSettings") {
			send({ event: "didReceiveGlobalSettings", payload: { settings: globals } });
		}
		if (msg.event === "setGlobalSettings") globals = msg.payload;
		received.push(msg);
		for (const w of [...waiters]) {
			if (w.test(msg)) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(msg);
			}
		}
	});
});

function send(msg) {
	socket.send(JSON.stringify(msg));
}

function waitFor(test, label, timeout = 8000) {
	const hit = received.find(test);
	if (hit) {
		received.splice(received.indexOf(hit), 1);
		return Promise.resolve(hit);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeout);
		waiters.push({ test, resolve: (m) => (clearTimeout(timer), received.splice(received.indexOf(m), 1), resolve(m)) });
	});
}

function decode(image) {
	return Buffer.from(image.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");
}

function save(name, svg) {
	if (!saveDir) return;
	const png = new Resvg(svg, { fitTo: { mode: "zoom", value: 2 }, font: { sansSerifFamily: "Liberation Sans", defaultFontFamily: "Liberation Sans" } })
		.render()
		.asPng();
	writeFileSync(join(saveDir, `${name}.png`), png);
}

async function settledImage(context, predicate, label) {
	// Animations produce several frames; wait for one that matches.
	for (;;) {
		const msg = await waitFor((m) => m.event === "setImage" && m.context === context, label);
		const svg = decode(msg.payload.image);
		if (predicate(svg)) return svg;
	}
}

const info = {
	application: { font: "", language: "en", platform: "mac", platformVersion: "15.0", version: "7.1.0.0" },
	plugin: { uuid: "com.execsam.claude-usage", version: "1.0.0.0" },
	devicePixelRatio: 2,
	colors: {},
	devices: [
		{ id: "dev1", name: "Stream Deck", size: { columns: 5, rows: 3 }, type: 0 },
		{ id: "dev7", name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 },
	],
};

const child = spawn(
	process.execPath,
	["--import", join(root, "scripts/mock-claude.mjs"), "bin/plugin.js", "-port", String(port), "-pluginUUID", "com.execsam.claude-usage", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)],
	{ cwd: pluginDir, stdio: ["ignore", "inherit", "inherit"] },
);

const results = [];
async function step(name, fn) {
	await fn();
	results.push(name);
	console.log(`  ✓ ${name}`);
}

try {
	await step("plugin registers", () => waitFor((m) => m.event === "registerPlugin", "registration"));

	await step("unconfigured key shows the setup screen", async () => {
		send({
			action: KEY,
			context: "key1",
			device: "dev1",
			event: "willAppear",
			payload: { controller: "Keypad", coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: {}, state: 0 },
		});
		const svg = await settledImage("key1", (s) => s.includes("CONNECT"), "setup image");
		save("1-setup", svg);
	});

	await step("property inspector can connect with a pasted cookie", async () => {
		send({ action: KEY, context: "key1", device: "dev1", event: "propertyInspectorDidAppear" });
		send({ action: KEY, context: "key1", event: "sendToPlugin", payload: { type: "hello" } });
		await waitFor((m) => m.event === "sendToPropertyInspector" && m.payload.type === "state", "initial PI state");
		send({ action: KEY, context: "key1", event: "sendToPlugin", payload: { type: "connect", raw: `cookie: sessionKey=${SESSION}; __cf_bm=old` } });
		const result = await waitFor((m) => m.event === "sendToPropertyInspector" && m.payload.type === "connectResult", "connect result");
		if (!result.payload.ok) throw new Error(`connect failed: ${result.payload.message}`);
		if (!/My Workspace · Max 20x/.test(result.payload.message)) throw new Error(`unexpected message: ${result.payload.message}`);
		if (!globals.cookie?.includes(SESSION)) throw new Error("cookie was not persisted to global settings");
		if (!globals.cookie.includes("__cf_bm=rotated")) throw new Error("rotated cookie was not persisted");
	});

	await step("key renders the session gauge after connecting", async () => {
		const svg = await settledImage("key1", (s) => s.includes("SESSION") && s.includes(">43<"), "gauge at 43%");
		save("2-gauge", svg);
	});

	await step("property inspector receives live usage + preview", async () => {
		const state = await waitFor((m) => m.event === "sendToPropertyInspector" && m.payload.type === "state" && m.payload.windows.length === 3, "state with windows");
		const ids = state.payload.windows.map((w) => w.id).join(",");
		if (ids !== "five_hour,seven_day,model:fable") throw new Error(`unexpected windows ${ids}`);
		await waitFor((m) => m.event === "sendToPropertyInspector" && m.payload.type === "preview", "preview");
	});

	await step("pressing the key refreshes and sweeps to the new value", async () => {
		await new Promise((r) => setTimeout(r, 4200)); // past the manual-refresh debounce
		send({ action: KEY, context: "key1", device: "dev1", event: "keyDown", payload: { settings: {}, coordinates: { column: 0, row: 0 }, isInMultiAction: false, state: 0 } });
		send({ action: KEY, context: "key1", device: "dev1", event: "keyUp", payload: { settings: {}, coordinates: { column: 0, row: 0 }, isInMultiAction: false, state: 0 } });
		const svg = await settledImage("key1", (s) => s.includes(">46<"), "gauge at 46%");
		save("3-refreshed", svg);
	});

	await step("holding the key cycles to the next limit", async () => {
		send({ action: KEY, context: "key1", device: "dev1", event: "keyDown", payload: { settings: {}, coordinates: { column: 0, row: 0 }, isInMultiAction: false, state: 0 } });
		const set = await waitFor((m) => m.event === "setSettings" && m.context === "key1", "setSettings after long press");
		send({ action: KEY, context: "key1", device: "dev1", event: "keyUp", payload: { settings: set.payload, coordinates: { column: 0, row: 0 }, isInMultiAction: false, state: 0 } });
		if (set.payload.metric !== "seven_day") throw new Error(`expected seven_day, got ${set.payload.metric}`);
		const svg = await settledImage("key1", (s) => s.includes("WEEKLY") && s.includes(">71<"), "weekly gauge");
		save("4-weekly", svg);
	});

	await step("Stream Deck + dial draws the touch strip and rotates focus", async () => {
		send({
			action: OVERVIEW,
			context: "dial1",
			device: "dev7",
			event: "willAppear",
			payload: { controller: "Encoder", coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: {}, state: 0 },
		});
		const fb = await waitFor((m) => m.event === "setFeedback" && m.context === "dial1", "dial feedback");
		save("5-strip", decode(fb.payload.canvas));
		send({ action: OVERVIEW, context: "dial1", device: "dev7", event: "dialRotate", payload: { settings: {}, coordinates: { column: 0, row: 0 }, ticks: 1, pressed: false } });
		const set = await waitFor((m) => m.event === "setSettings" && m.context === "dial1", "dial focus change");
		if (set.payload.focus !== "seven_day") throw new Error(`expected focus seven_day, got ${set.payload.focus}`);
	});

	await step("overview key renders bars", async () => {
		send({
			action: OVERVIEW,
			context: "key2",
			device: "dev1",
			event: "willAppear",
			payload: { controller: "Keypad", coordinates: { column: 1, row: 0 }, isInMultiAction: false, settings: { style: "bars" }, state: 0 },
		});
		const svg = await settledImage("key2", (s) => s.includes("FABLE") && s.includes("WEEKLY"), "overview bars");
		save("6-overview", svg);
	});

	await step("disconnect returns keys to setup", async () => {
		send({ action: KEY, context: "key1", event: "sendToPlugin", payload: { type: "disconnect" } });
		await settledImage("key2", (s) => s.includes("CONNECT"), "setup after disconnect");
		if (globals.cookie) throw new Error("cookie still stored after disconnect");
	});

	console.log(`\nSmoke test passed (${results.length} steps).`);
} catch (err) {
	console.error(`\nSmoke test FAILED: ${err.message}`);
	process.exitCode = 1;
} finally {
	child.kill();
	wss.close();
}
