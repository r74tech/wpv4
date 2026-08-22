import { formatRelativeTime } from "../lib/relative-time";

export function applyRelativeTimeLabels(root: ParentNode = document): void {
	const now = Date.now();
	for (const element of root.querySelectorAll<HTMLTimeElement>("time[data-relative-time]")) {
		const timestamp = Date.parse(element.dateTime);
		if (!Number.isNaN(timestamp))
			element.dataset.relativeLabel = formatRelativeTime(timestamp, now);
	}
}
