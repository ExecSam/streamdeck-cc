/** Formatting helpers for tiny screens. */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "3d 4h", "2h 14m", "14m", "42s", "now". */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms)) return "—";
	if (ms <= 0) return "now";
	if (ms >= DAY) {
		const d = Math.floor(ms / DAY);
		const h = Math.floor((ms % DAY) / HOUR);
		return h ? `${d}d ${h}h` : `${d}d`;
	}
	if (ms >= HOUR) {
		const h = Math.floor(ms / HOUR);
		const m = Math.floor((ms % HOUR) / MIN);
		return m ? `${h}h ${m}m` : `${h}h`;
	}
	if (ms >= MIN) return `${Math.floor(ms / MIN)}m`;
	return `${Math.max(1, Math.floor(ms / 1000))}s`;
}

/** Most significant unit only: "3d", "2h", "14m", "42s". */
export function formatDurationShort(ms: number): string {
	return formatDuration(ms).split(" ")[0];
}

/** Clock-style countdown: "14:05" under an hour, "2:14" (h:mm) under a day, else "3d 4h". */
export function formatClock(ms: number): string {
	if (!Number.isFinite(ms)) return "—";
	if (ms <= 0) return "0:00";
	if (ms < HOUR) {
		const total = Math.ceil(ms / 1000);
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
	}
	if (ms < DAY) {
		const total = Math.floor(ms / MIN);
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
	}
	return formatDuration(ms);
}

export function formatPercent(percent: number): string {
	if (!Number.isFinite(percent)) return "–";
	const rounded = Math.round(percent);
	// Never round a not-quite-full window up to 100 — "100%" should mean you're actually limited.
	if (rounded >= 100 && percent < 100) return "99";
	return String(Math.max(0, Math.min(999, rounded)));
}

export function formatMoney(minor: number, currency: string): string {
	try {
		return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100);
	} catch {
		return `${(minor / 100).toFixed(2)} ${currency}`;
	}
}
