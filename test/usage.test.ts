import { describe, expect, it } from "vitest";

import { elapsedFraction, mostConstrained, parseUsage, pickWindow, project } from "../src/core/usage.js";

const NOW = Date.parse("2026-07-03T00:00:00Z");

describe("parseUsage", () => {
	it("parses the classic flat payload", () => {
		const snap = parseUsage(
			{
				five_hour: { utilization: 9, resets_at: "2025-12-23T16:00:00.000Z" },
				seven_day: { utilization: 4, resets_at: "2025-12-29T23:00:00.000Z" },
				seven_day_opus: { utilization: 1 },
				seven_day_oauth_apps: null,
			},
			"web",
			NOW,
		);
		expect(snap.windows.map((w) => [w.id, w.short, w.percent])).toEqual([
			["five_hour", "SESSION", 9],
			["seven_day", "WEEKLY", 4],
			["seven_day_opus", "OPUS", 1],
		]);
		expect(snap.windows[0].resetsAt).toBe(Date.parse("2025-12-23T16:00:00.000Z"));
		expect(snap.windows[2].resetsAt).toBeNull();
		expect(snap.fetchedAt).toBe(NOW);
	});

	it("reads model-scoped weekly caps from the limits array (microsecond timestamps)", () => {
		const snap = parseUsage(
			{
				five_hour: { utilization: 11.0, resets_at: "2026-07-03T00:30:00.282668+00:00" },
				seven_day: { utilization: 9.0, resets_at: "2026-07-08T09:00:00.282694+00:00" },
				seven_day_opus: null,
				seven_day_sonnet: null,
				limits: [
					{ kind: "session", group: "session", percent: 11, resets_at: "2026-07-03T00:30:00.282668+00:00", scope: null },
					{ kind: "weekly_all", group: "weekly", percent: 9, resets_at: "2026-07-08T09:00:00.282694+00:00", scope: null },
					{
						kind: "weekly_scoped",
						group: "weekly",
						percent: 5,
						resets_at: "2026-07-08T09:00:00.283070+00:00",
						scope: { model: { id: null, display_name: "Fable" }, surface: null },
					},
					{ kind: "weekly_scoped", percent: 3, scope: { model: null } },
				],
			},
			"web",
			NOW,
		);
		expect(snap.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day", "model:fable"]);
		const fable = snap.windows[2];
		expect(fable).toMatchObject({ short: "FABLE", label: "Weekly · Fable", percent: 5 });
		expect(fable.resetsAt).toBe(Date.parse("2026-07-08T09:00:00.283Z"));
		expect(snap.windows[0].resetsAt).toBe(Date.parse("2026-07-03T00:30:00.282Z"));
	});

	it("falls back to the limits array when flat fields are missing", () => {
		const snap = parseUsage(
			{ limits: [{ kind: "session", percent: 40, resets_at: "2026-07-03T02:00:00Z" }, { kind: "weekly_all", percent: 12 }] },
			"claude-code",
			NOW,
		);
		expect(snap.windows.map((w) => [w.id, w.percent])).toEqual([
			["five_hour", 40],
			["seven_day", 12],
		]);
		expect(snap.source).toBe("claude-code");
	});

	it("keeps unknown windows, ignores Claude Design, and reads extra usage", () => {
		const snap = parseUsage(
			{
				five_hour: { utilization: 12.5, resets_at: "2025-12-25T12:00:00.000Z" },
				seven_day_omelette: { utilization: 29 },
				seven_day_routines: { utilization: 18 },
				seven_day_new_thing: { utilization: "7" },
				extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 500, currency: "EUR" },
			},
			"web",
			NOW,
		);
		expect(snap.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day_routines", "seven_day_new_thing"]);
		expect(snap.windows[2]).toMatchObject({ short: "NEW THI", percent: 7, label: "Weekly · New Thing" });
		expect(snap.extra).toEqual({ enabled: true, usedMinor: 500, limitMinor: 2000, currency: "EUR" });
	});

	it("rejects non-objects", () => {
		expect(() => parseUsage([], "web")).toThrow();
		expect(() => parseUsage(null, "web")).toThrow();
	});
});

describe("pace + projections", () => {
	const session = {
		id: "five_hour",
		label: "Session",
		short: "SESSION",
		percent: 60,
		resetsAt: NOW + 3 * 3_600_000, // 2h into a 5h window
		windowMs: 5 * 3_600_000,
	};

	it("computes elapsed fraction", () => {
		expect(elapsedFraction(session, NOW)).toBeCloseTo(0.4);
		expect(elapsedFraction({ ...session, resetsAt: null }, NOW)).toBeNull();
	});

	it("projects when the limit will be hit", () => {
		const p = project(session, NOW)!;
		expect(p.paceDelta).toBeCloseTo(20);
		expect(p.paceRatio).toBeCloseTo(1.5);
		// 60% in 2h → 30%/h → 40% more takes 80 minutes, before the reset in 3h.
		expect(p.limitAt).toBe(NOW + 80 * 60_000);
	});

	it("returns no limit time when usage is sustainable", () => {
		const p = project({ ...session, percent: 20 }, NOW)!;
		expect(p.limitAt).toBeNull();
		expect(p.paceDelta).toBeLessThan(0);
	});

	it("picks the most constrained window for auto", () => {
		const snap = parseUsage({ five_hour: { utilization: 30 }, seven_day: { utilization: 70 } }, "web", NOW);
		expect(mostConstrained(snap.windows)?.id).toBe("seven_day");
		expect(pickWindow(snap, "auto")?.id).toBe("seven_day");
		expect(pickWindow(snap, "five_hour")?.id).toBe("five_hour");
		expect(pickWindow(snap, "missing")?.id).toBe("five_hour");
		expect(pickWindow(null, "auto")).toBeUndefined();
	});
});
