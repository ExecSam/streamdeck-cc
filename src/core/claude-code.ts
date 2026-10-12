/**
 * Reads the OAuth login that Claude Code stores locally. Used only when the user opts in to the
 * "Claude Code login" source or fallback. The token is read fresh on every refresh and is never
 * copied into the plugin's own settings or refreshed by us (that would rotate Claude Code's tokens).
 *
 *  - Windows / Linux, and older macOS installs: ~/.claude/.credentials.json
 *  - macOS: the "Claude Code-credentials" item in the login Keychain (macOS asks once for access)
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { UsageError } from "./client.js";

export type ClaudeCodeToken = {
	accessToken: string;
	expiresAt?: number;
	subscriptionType?: string;
	rateLimitTier?: string;
};

export async function readClaudeCodeToken(): Promise<ClaudeCodeToken> {
	const raw = (await readCredentialsFile()) ?? (process.platform === "darwin" ? await readKeychain() : undefined);
	if (!raw) {
		throw new UsageError(
			"not_configured",
			"Couldn't find a Claude Code login on this computer. Run `claude` and sign in, or use the browser cookie instead.",
		);
	}
	return parseClaudeCodeCredentials(raw);
}

export function parseClaudeCodeCredentials(raw: string): ClaudeCodeToken {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		throw new UsageError("parse", "Claude Code's credentials file couldn't be read.");
	}
	const oauth = (json as { claudeAiOauth?: Record<string, unknown> })?.claudeAiOauth;
	const accessToken = oauth?.accessToken;
	if (typeof accessToken !== "string" || !accessToken) {
		throw new UsageError("not_configured", "Claude Code isn't signed in with a Claude subscription.");
	}
	const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
	if (expiresAt && expiresAt < Date.now()) {
		throw new UsageError("auth", "Your Claude Code login token has expired. Run `claude` once to refresh it.");
	}
	return {
		accessToken,
		expiresAt,
		subscriptionType: typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType : undefined,
		rateLimitTier: typeof oauth?.rateLimitTier === "string" ? oauth.rateLimitTier : undefined,
	};
}

async function readCredentialsFile(): Promise<string | undefined> {
	const dirs = [process.env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude")].filter((d): d is string => !!d);
	for (const dir of dirs) {
		try {
			return await readFile(join(dir, ".credentials.json"), "utf8");
		} catch {
			// Try the next location.
		}
	}
	return undefined;
}

function readKeychain(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"/usr/bin/security",
			["find-generic-password", "-s", "Claude Code-credentials", "-w"],
			{ timeout: 30_000 },
			(err, stdout) => resolve(err ? undefined : stdout.trim() || undefined),
		);
	});
}
