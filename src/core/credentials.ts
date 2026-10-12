/**
 * Turns whatever the user pasted from their browser into credentials we can use.
 *
 * Accepted inputs (all detected automatically):
 *  - a bare `sessionKey` value (`sk-ant-sid01-...`)
 *  - the full `Cookie` request header value (with or without the `cookie:` prefix)
 *  - DevTools "Copy as cURL" (bash or Windows cmd), "Copy as fetch (Node.js)" and "Copy as PowerShell"
 *  - Firefox "Copy Request Headers"
 *
 * From the richer formats we also pick up the browser's User-Agent and the organization UUID from the
 * request URL, which saves a round-trip and helps requests look like they came from that browser.
 */

export type ParsedCredentials = {
	/** Value for the `Cookie` request header. */
	cookie: string;
	/** Browser User-Agent, when the paste included one. */
	userAgent?: string;
	/** Organization UUID, from the request URL or the `lastActiveOrg` cookie. */
	orgId?: string;
};

export type ParseResult = { ok: true; value: ParsedCredentials } | { ok: false; error: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_KEY = /sessionKey=(sk-ant-[A-Za-z0-9_-]+)/;
const BARE_SESSION_KEY = /^sk-ant-[A-Za-z0-9_-]{8,}$/;

export function parseCredentialInput(raw: string): ParseResult {
	let text = (raw ?? "").trim();
	if (!text) {
		return { ok: false, error: "Paste your claude.ai cookie (or a copied cURL command) first." };
	}

	// Windows "Copy as cURL (cmd)" escapes quotes and specials with carets: ^"cookie: a=b^"
	if (text.includes('^"')) {
		text = text.replace(/\^(.)/g, "$1");
	}

	let cookie = extractCookie(text);
	if (!cookie || !SESSION_KEY.test(cookie)) {
		const key = text.match(SESSION_KEY)?.[1];
		if (key) cookie = `sessionKey=${key}`;
	}
	if (!cookie && BARE_SESSION_KEY.test(text)) {
		cookie = `sessionKey=${text}`;
	}

	if (!cookie || !SESSION_KEY.test(cookie)) {
		if (/credentials["']?\s*:\s*["']include/.test(text)) {
			return {
				ok: false,
				error: 'Browser "Copy as fetch" leaves the cookies out. Use "Copy as cURL" instead, or copy the Cookie header value.',
			};
		}
		return {
			ok: false,
			error: "Couldn't find a sessionKey in that. Copy the whole Cookie header from the “usage” request (it contains sessionKey=sk-ant-…).",
		};
	}

	cookie = normaliseCookieHeader(cookie);
	const userAgent = extractUserAgent(text);
	const orgId =
		text.match(new RegExp(`/api/organizations/(${UUID})`, "i"))?.[1] ??
		parseCookieHeader(cookie).get("lastActiveOrg")?.match(new RegExp(`^${UUID}$`, "i"))?.[0];

	return {
		ok: true,
		value: {
			cookie,
			...(userAgent ? { userAgent } : {}),
			...(orgId ? { orgId: orgId.toLowerCase() } : {}),
		},
	};
}

function extractCookie(text: string): string | undefined {
	// "Cookie: …" copied straight from the headers panel (may wrap over several lines).
	if (/^cookie:/i.test(text)) return text.replace(/^cookie:\s*/i, "");

	// curl: -b '...' / --cookie "..."
	const curlCookie = text.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/);
	if (curlCookie) return curlCookie[2];

	// curl -H 'cookie: ...'  /  fetch { "cookie": "..." }
	const header = text.match(/(['"])cookie:\s*([\s\S]*?)\1/i);
	if (header) return header[2];
	const json = text.match(/["']cookie["']\s*:\s*(["'])([\s\S]*?)\1/i);
	if (json) return json[2];

	// PowerShell: $session.Cookies.Add((New-Object System.Net.Cookie("name", "value", "/", ".claude.ai")))
	const psPairs = [...text.matchAll(/System\.Net\.Cookie\(\s*"([^"]+)"\s*,\s*"([^"]*)"/g)];
	if (psPairs.length) return psPairs.map(([, k, v]) => `${k}=${v}`).join("; ");

	// Raw request headers block: a line starting with "Cookie:"
	const line = text.match(/^\s*cookie:\s*(.+)$/im);
	if (line) return line[1];

	// A pasted cookie header value on its own.
	if (/^[^\s=;]+=[^;]*(;\s*[^\s=;]+=[^;]*)*;?$/.test(text.replace(/\s*\n\s*/g, " "))) {
		return text;
	}
	return undefined;
}

function extractUserAgent(text: string): string | undefined {
	const patterns = [
		/(['"])user-agent:\s*([^'"\n]+)\1/i,
		/["']user-agent["']\s*:\s*["']([^'"\n]+)["']/i,
		/\$session\.UserAgent\s*=\s*"([^"\n]+)"/i,
		/^\s*user-agent:\s*(.+)$/im,
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match) {
			const ua = match[match.length - 1].trim();
			if (/^Mozilla\//.test(ua)) return ua;
		}
	}
	return undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Cookie jar helpers
 * ---------------------------------------------------------------------------------------------- */

export function parseCookieHeader(header: string): Map<string, string> {
	const jar = new Map<string, string>();
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx <= 0) continue;
		const name = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (name) jar.set(name, value);
	}
	return jar;
}

export function serializeCookies(jar: Map<string, string>): string {
	return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function normaliseCookieHeader(header: string): string {
	return serializeCookies(parseCookieHeader(header.replace(/^\s*cookie:\s*/i, "").replace(/\s*\n\s*/g, " ")));
}

/**
 * Applies `Set-Cookie` response headers to a cookie header, the way a browser would keep its jar fresh
 * (claude.ai rotates Cloudflare cookies and occasionally the session itself). We never drop
 * `sessionKey`: if the server expires it, the next request reports the auth error instead.
 */
export function mergeSetCookies(header: string, setCookies: readonly string[]): { header: string; changed: boolean } {
	const jar = parseCookieHeader(header);
	let changed = false;
	for (const line of setCookies) {
		const [pair, ...attrs] = line.split(";");
		const idx = pair.indexOf("=");
		if (idx <= 0) continue;
		const name = pair.slice(0, idx).trim();
		const value = pair.slice(idx + 1).trim();
		const expired =
			value === "" ||
			attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) ||
			attrs.some((a) => {
				const m = a.match(/^\s*expires\s*=\s*(.+)$/i);
				return m ? Date.parse(m[1]) < Date.now() : false;
			});
		if (expired) {
			if (name !== "sessionKey" && jar.delete(name)) changed = true;
			continue;
		}
		if (jar.get(name) !== value) {
			jar.set(name, value);
			changed = true;
		}
	}
	return { header: changed ? serializeCookies(jar) : header, changed };
}

/** `sk-ant-…a1b2` — enough to recognise which session is stored without revealing it. */
export function maskSessionKey(cookie: string | undefined): string | undefined {
	const key = cookie?.match(SESSION_KEY)?.[1];
	if (!key) return undefined;
	return `sk-ant-…${key.slice(-4)}`;
}
