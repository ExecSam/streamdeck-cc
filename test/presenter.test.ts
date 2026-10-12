import { afterEach, describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/core/client.js";
import { UsageStore } from "../src/core/store.js";
import { Presenter, type Surface } from "../src/presenter.js";

const ORG = "0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab";
const NOW = Date.parse("2026-10-12T12:00:00Z");

function setup(percent = { value: 42 }) {
	const fetch: FetchLike = async () =>
		new Response(
			JSON.stringify({
				five_hour: { utilization: percent.value, resets_at: new Date(NOW + 2 * 3_600_000).toISOString() },
				seven_day: { utilization: 18, resets_at: new Date(NOW + 4 * 86_400_000).toISOString() },
			}),
			{ status: 200 },
		);
	const store = new UsageStore({
		load: async () => ({ cookie: "sessionKey=sk-ant-sid01-presenterpresenter", orgId: ORG }),
		save: async () => {},
		fetch,
	});
	const presenter = new Presenter(store);
	const drawn: string[] = [];
	const surface: Surface = {
		id: "key1",
		isDial: false,
		draw: async (url) => {
			drawn.push(Buffer.from(url.split(",")[1], "base64").toString("utf8"));
		},
	};
	return { store, presenter, surface, drawn, percent };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Presenter", () => {
	it("shows loading until settings are ready, then animates up to the value", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { store, presenter, surface, drawn } = setup();
		presenter.add(surface, "gauge", {});
		await vi.advanceTimersByTimeAsync(1);
		expect(drawn.at(-1)).toContain("LOADING");

		await store.init();
		await store.refresh();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(drawn.at(-1)).toContain(">42<");
		// The sweep produced intermediate frames on the way up.
		expect(drawn.some((svg) => /SESSION/.test(svg) && !svg.includes(">42<"))).toBe(true);
		presenter.dispose();
		store.dispose();
	});

	it("doesn't redraw when nothing changed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { store, presenter, surface, drawn } = setup();
		await store.init();
		await store.refresh();
		presenter.add(surface, "gauge", { metric: "seven_day" });
		await vi.advanceTimersByTimeAsync(2_000);
		const count = drawn.length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(drawn.length).toBe(count);
		expect(drawn.at(-1)).toContain("WEEKLY");
		presenter.dispose();
		store.dispose();
	});

	it("eases to new values after a refresh and respects settings changes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { store, presenter, surface, drawn, percent } = setup();
		await store.init();
		await store.refresh();
		presenter.add(surface, "gauge", {});
		await vi.advanceTimersByTimeAsync(2_000);

		percent.value = 64;
		await vi.advanceTimersByTimeAsync(5_000);
		await store.refresh({ manual: true });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(drawn.at(-1)).toContain(">64<");

		presenter.updateSettings("key1", { style: "countdown" });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(drawn.at(-1)).toMatch(/>(1:59|2:00)</);
		expect(drawn.at(-1)).toContain("64% used");
		presenter.dispose();
		store.dispose();
	});
});
