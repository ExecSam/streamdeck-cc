/**
 * Property-inspector harness: plays the Stream Deck app between the built plugin (with a fake
 * claude.ai) and the real settings page running in headless Chromium, then screenshots the page in
 * its main states. Handy for checking UI changes and regenerating README screenshots.
 *
 *   npm run build && node scripts/pi-harness.mjs <outDir>
 *
 * Needs Playwright (`npm i -D playwright` or a global install) and a Chromium build.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
let chromium;
try {
	({ chromium } = require("playwright"));
} catch {
	({ chromium } = require(join(process.env.NODE_PATH ?? "/opt/node-tools/node_modules", "playwright")));
}

const root = resolve(import.meta.dirname, "..");
const pluginDir = join(root, "com.execsam.claude-usage.sdPlugin");
const out = resolve(process.argv[2] ?? "docs/images");
mkdirSync(out, { recursive: true });

const ACTION = process.env.PI_ACTION ?? "com.execsam.claude-usage.gauge";
const CONTEXT = "key1";
let globals = {};
let keySettings = { style: "ring" };
let plugin;
let pi;

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.once("listening", r));
const port = wss.address().port;

const sendTo = (ws, msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
const toPlugin = (msg) => sendTo(plugin, msg);
const toPi = (msg) => sendTo(pi, msg);

wss.on("connection", (ws) => {
	ws.on("message", (data) => {
		const msg = JSON.parse(String(data));
		switch (msg.event) {
			case "registerPlugin":
				plugin = ws;
				break;
			case "registerPropertyInspector":
				pi = ws;
				break;
			case "getGlobalSettings":
				sendTo(ws, { event: "didReceiveGlobalSettings", payload: { settings: globals } });
				break;
			case "setGlobalSettings":
				globals = msg.payload;
				break;
			case "sendToPlugin":
				toPlugin({ event: "sendToPlugin", action: ACTION, context: CONTEXT, payload: msg.payload });
				break;
			case "sendToPropertyInspector":
				toPi({ event: "sendToPropertyInspector", action: ACTION, context: CONTEXT, payload: msg.payload });
				break;
			case "setSettings":
				keySettings = msg.payload;
				if (ws === pi) {
					toPlugin({ event: "didReceiveSettings", action: ACTION, context: CONTEXT, device: "dev1", payload: { settings: keySettings, coordinates: { column: 0, row: 0 }, isInMultiAction: false } });
				} else {
					toPi({ event: "didReceiveSettings", action: ACTION, context: CONTEXT, device: "dev1", payload: { settings: keySettings, coordinates: { column: 0, row: 0 }, isInMultiAction: false } });
				}
				break;
			case "openUrl":
				console.log(`  (openUrl ${msg.payload.url})`);
				break;
		}
	});
});

const info = {
	application: { font: "", language: "en", platform: "mac", platformVersion: "15.0", version: "7.1.0.0" },
	plugin: { uuid: "com.execsam.claude-usage", version: "1.0.0.0" },
	devicePixelRatio: 2,
	colors: {},
	devices: [{ id: "dev1", name: "Stream Deck", size: { columns: 5, rows: 3 }, type: 0 }],
};

const child = spawn(
	process.execPath,
	["--import", join(root, "scripts/mock-claude.mjs"), "bin/plugin.js", "-port", String(port), "-pluginUUID", "com.execsam.claude-usage", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)],
	{ cwd: pluginDir, stdio: ["ignore", "inherit", "inherit"] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (!plugin) await sleep(50);

toPlugin({
	action: ACTION,
	context: CONTEXT,
	device: "dev1",
	event: "willAppear",
	payload: { controller: "Keypad", coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: keySettings, state: 0 },
});
toPlugin({ action: ACTION, context: CONTEXT, device: "dev1", event: "propertyInspectorDidAppear" });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
page.on("pageerror", (err) => {
	console.error(`PAGE ERROR: ${err.message}`);
	process.exitCode = 1;
});
page.on("dialog", (d) => d.accept());

await page.goto(pathToFileURL(join(pluginDir, "ui/settings.html")).href);
await page.evaluate(
	([p, ctx, inf, act]) => window.connectElgatoStreamDeckSocket(p, ctx, "registerPropertyInspector", inf, act),
	[port, CONTEXT, JSON.stringify(info), JSON.stringify({ action: ACTION, context: CONTEXT, device: "dev1", payload: { settings: keySettings, controller: "Keypad", coordinates: { column: 0, row: 0 } } })],
);

try {
	await page.waitForSelector("#setup:not([hidden])");
	await sleep(400);
	await page.screenshot({ path: join(out, "pi-setup.png"), fullPage: true });
	console.log("  ✓ setup guide");

	await page.click('#browserTabs [data-browser="firefox"]');
	const firefoxStep = await page.evaluate(() =>
		[...document.querySelectorAll('.steps [data-only="firefox"]')].filter((n) => !n.hidden).map((n) => n.textContent).join(" "),
	);
	if (!/Copy as cURL/.test(firefoxStep)) throw new Error("Firefox instructions not shown");
	await page.click('#browserTabs [data-browser="chromium"]');

	await page.fill("#paste", "nonsense");
	await page.click("#connect");
	await page.waitForSelector("#connectResult.bad");
	console.log(`  ✓ rejects bad paste: "${await page.textContent("#connectResult")}"`);

	await page.fill("#paste", `curl 'https://claude.ai/api/organizations/0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab/usage' -b 'sessionKey=sk-ant-sid01-harnessharnessharness; a=b' -H 'user-agent: Mozilla/5.0 Test'`);
	await page.click("#connect");
	await page.waitForSelector("#usage:not([hidden])");
	await page.waitForFunction(() => document.querySelectorAll("#windows .win").length === 3);
	await sleep(1500);
	await page.screenshot({ path: join(out, "pi-connected.png"), fullPage: true });
	console.log(`  ✓ connected: "${await page.textContent("#statusText")}"`);

	await page.selectOption("#metric", "seven_day");
	await page.click('#style button:nth-child(2)');
	await sleep(300);
	if (keySettings.metric !== "seven_day" || keySettings.style !== "liquid") throw new Error(`settings not saved: ${JSON.stringify(keySettings)}`);
	console.log("  ✓ per-key settings saved");

	await page.click('#themes button:nth-child(2)');
	await sleep(400);
	if (globals.theme !== "claude") throw new Error(`theme not saved: ${globals.theme}`);
	console.log("  ✓ theme saved to global settings");
	await sleep(1200);
	await page.screenshot({ path: join(out, "pi-themed.png"), fullPage: true });

	await page.click("#disconnect");
	await page.waitForSelector("#setup:not([hidden])");
	console.log("  ✓ disconnect");
	console.log(`\nScreenshots in ${out}`);
} catch (err) {
	console.error(`PI harness FAILED: ${err.message}`);
	await page.screenshot({ path: join(out, "pi-failure.png"), fullPage: true });
	process.exitCode = 1;
} finally {
	await browser.close();
	child.kill();
	wss.close();
}
