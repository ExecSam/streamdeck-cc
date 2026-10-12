/**
 * Preloaded (node --import) by the smoke test: replaces fetch with a fake claude.ai so the built
 * plugin can be exercised end-to-end without network access or real credentials.
 */

const ORG = "0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab";
const H = 3_600_000;
let usageCalls = 0;

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "set-cookie": "__cf_bm=rotated; Path=/" } });

globalThis.fetch = async (input, init = {}) => {
	const url = String(input);
	const cookie = init.headers?.cookie ?? "";
	if (url.startsWith("https://claude.ai/") && !cookie.includes("sessionKey=sk-ant-")) {
		return json({ type: "error", error: { type: "permission_error" } }, 403);
	}
	if (url === "https://claude.ai/api/organizations") {
		return json([{ uuid: ORG, name: "My Workspace", capabilities: ["chat", "claude_max"], rate_limit_tier: "default_claude_max_20x" }]);
	}
	if (url === `https://claude.ai/api/organizations/${ORG}/usage`) {
		usageCalls++;
		const now = Date.now();
		return json({
			five_hour: { utilization: 40 + usageCalls * 3, resets_at: new Date(now + 2 * H + 14 * 60_000).toISOString() },
			seven_day: { utilization: 71, resets_at: new Date(now + 76 * H).toISOString() },
			seven_day_sonnet: null,
			limits: [{ kind: "weekly_scoped", percent: 12, resets_at: new Date(now + 76 * H).toISOString(), scope: { model: { display_name: "Fable" } } }],
		});
	}
	return new Response("not found", { status: 404 });
};
