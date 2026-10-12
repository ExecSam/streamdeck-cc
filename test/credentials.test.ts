import { describe, expect, it } from "vitest";

import { maskSessionKey, mergeSetCookies, parseCredentialInput } from "../src/core/credentials.js";

const KEY = "sk-ant-sid01-AbC_dEf-1234567890abcdefXYZ";
const ORG = "0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function ok(raw: string) {
	const result = parseCredentialInput(raw);
	if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
	return result.value;
}

describe("parseCredentialInput", () => {
	it("accepts a bare sessionKey", () => {
		expect(ok(KEY)).toEqual({ cookie: `sessionKey=${KEY}` });
	});

	it("accepts a full cookie header and picks the org from lastActiveOrg", () => {
		const value = ok(`anthropic-device-id=abc; sessionKey=${KEY}; lastActiveOrg=${ORG}; cf_clearance=xyz.123-456`);
		expect(value.cookie).toBe(`anthropic-device-id=abc; sessionKey=${KEY}; lastActiveOrg=${ORG}; cf_clearance=xyz.123-456`);
		expect(value.orgId).toBe(ORG);
	});

	it("strips a leading 'cookie:' and joins wrapped lines", () => {
		const value = ok(`Cookie: a=1;\n sessionKey=${KEY};\n b=2`);
		expect(value.cookie).toBe(`a=1; sessionKey=${KEY}; b=2`);
	});

	it("parses Chrome 'Copy as cURL (bash)' with -b", () => {
		const curl = [
			`curl 'https://claude.ai/api/organizations/${ORG}/usage' \\`,
			`  -H 'accept: */*' \\`,
			`  -H 'anthropic-client-platform: web_claude_ai' \\`,
			`  -b 'sessionKey=${KEY}; lastActiveOrg=${ORG}; cf_clearance=abc' \\`,
			`  -H 'referer: https://claude.ai/settings/usage' \\`,
			`  -H 'user-agent: ${UA}'`,
		].join("\n");
		const value = ok(curl);
		expect(value.cookie).toBe(`sessionKey=${KEY}; lastActiveOrg=${ORG}; cf_clearance=abc`);
		expect(value.orgId).toBe(ORG);
		expect(value.userAgent).toBe(UA);
	});

	it("parses Firefox cURL with -H 'Cookie: ...'", () => {
		const value = ok(`curl 'https://claude.ai/api/organizations/${ORG}/usage' -H 'User-Agent: ${UA}' -H 'Cookie: sessionKey=${KEY}; x=y'`);
		expect(value.cookie).toBe(`sessionKey=${KEY}; x=y`);
		expect(value.userAgent).toBe(UA);
	});

	it("parses Windows 'Copy as cURL (cmd)' caret escaping", () => {
		const cmd = `curl ^"https://claude.ai/api/organizations/${ORG}/usage^" ^\n  -H ^"user-agent: ${UA}^" ^\n  -b ^"sessionKey=${KEY}; foo=bar^"`;
		const value = ok(cmd);
		expect(value.cookie).toBe(`sessionKey=${KEY}; foo=bar`);
		expect(value.orgId).toBe(ORG);
	});

	it("parses 'Copy as fetch (Node.js)'", () => {
		const js = `fetch("https://claude.ai/api/organizations/${ORG}/usage", {\n  "headers": {\n    "accept": "*/*",\n    "cookie": "sessionKey=${KEY}; a=b",\n    "user-agent": "${UA}"\n  },\n  "method": "GET"\n});`;
		const value = ok(js);
		expect(value.cookie).toBe(`sessionKey=${KEY}; a=b`);
		expect(value.userAgent).toBe(UA);
	});

	it("parses 'Copy as PowerShell'", () => {
		const ps = [
			"$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession",
			`$session.UserAgent = "${UA}"`,
			`$session.Cookies.Add((New-Object System.Net.Cookie("sessionKey", "${KEY}", "/", ".claude.ai")))`,
			`$session.Cookies.Add((New-Object System.Net.Cookie("lastActiveOrg", "${ORG}", "/", ".claude.ai")))`,
			`Invoke-WebRequest -UseBasicParsing -Uri "https://claude.ai/api/organizations/${ORG}/usage" -WebSession $session`,
		].join("\n");
		const value = ok(ps);
		expect(value.cookie).toBe(`sessionKey=${KEY}; lastActiveOrg=${ORG}`);
		expect(value.userAgent).toBe(UA);
		expect(value.orgId).toBe(ORG);
	});

	it("parses a raw request-headers block", () => {
		const headers = `GET /api/organizations/${ORG}/usage HTTP/2\nHost: claude.ai\nUser-Agent: ${UA}\nCookie: sessionKey=${KEY}; z=1\nAccept: */*`;
		const value = ok(headers);
		expect(value.cookie).toBe(`sessionKey=${KEY}; z=1`);
		expect(value.userAgent).toBe(UA);
	});

	it("explains browser 'Copy as fetch' which omits cookies", () => {
		const result = parseCredentialInput(`fetch("https://claude.ai/api/organizations/${ORG}/usage", { "credentials": "include" });`);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/Copy as cURL/);
	});

	it("rejects input without a sessionKey", () => {
		expect(parseCredentialInput("").ok).toBe(false);
		expect(parseCredentialInput("hello world").ok).toBe(false);
		expect(parseCredentialInput("a=1; b=2").ok).toBe(false);
	});
});

describe("cookie jar", () => {
	it("merges rotated cookies and keeps the rest", () => {
		const { header, changed } = mergeSetCookies(`sessionKey=${KEY}; __cf_bm=old; keep=1`, [
			"__cf_bm=new; path=/; expires=Fri, 01 Jan 2100 00:00:00 GMT; HttpOnly",
			"fresh=yes; Path=/",
		]);
		expect(changed).toBe(true);
		expect(header).toBe(`sessionKey=${KEY}; __cf_bm=new; keep=1; fresh=yes`);
	});

	it("drops expired cookies but never the sessionKey", () => {
		const { header } = mergeSetCookies(`sessionKey=${KEY}; gone=1`, ["gone=; Max-Age=0", "sessionKey=; Max-Age=0"]);
		expect(header).toBe(`sessionKey=${KEY}`);
	});

	it("reports no change when nothing differs", () => {
		expect(mergeSetCookies(`sessionKey=${KEY}`, [`sessionKey=${KEY}; Path=/`]).changed).toBe(false);
	});

	it("masks the session key", () => {
		expect(maskSessionKey(`a=b; sessionKey=${KEY}`)).toBe("sk-ant-…XYZ".replace("…XYZ", `…${KEY.slice(-4)}`));
		expect(maskSessionKey("a=b")).toBeUndefined();
	});
});
