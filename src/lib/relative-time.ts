const relativeTimeFormatter = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });

const relativeUnits = [
	["day", 24 * 60 * 60],
	["hour", 60 * 60],
	["minute", 60],
	["second", 1],
] as const;

export function formatRelativeTime(timestampMs: number, nowMs = Date.now()): string {
	const secondsFromNow = (timestampMs - nowMs) / 1000;
	const absoluteSeconds = Math.abs(secondsFromNow);

	for (const [unit, secondsPerUnit] of relativeUnits) {
		if (absoluteSeconds >= secondsPerUnit || unit === "second") {
			return relativeTimeFormatter
				.format(Math.round(secondsFromNow / secondsPerUnit), unit)
				.replace(/(\d)\s+(?=[^\d\s])/g, "$1");
		}
	}

	return relativeTimeFormatter.format(0, "second");
}
