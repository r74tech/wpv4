import type { FC } from "hono/jsx";
import { formatRelativeTime } from "@/lib/relative-time";

type Props = {
	value: string | null;
	empty?: string;
};

const dateTimeFormat = new Intl.DateTimeFormat("ja-JP", {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});

function parseDateTime(value: string): Date | null {
	const normalized = value.includes("T") ? value : value.replace(" ", "T");
	const date = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
	return Number.isNaN(date.getTime()) ? null : date;
}

export const RelativeDateTime: FC<Props> = ({ value, empty = "—" }) => {
	if (!value) return <>{empty}</>;

	const date = parseDateTime(value);
	if (!date) return <>{value}</>;
	const formattedDate = dateTimeFormat.format(date);
	const relativeLabel = formatRelativeTime(date.getTime());

	return (
		<time
			class="relative-time"
			datetime={date.toISOString()}
			data-relative-time
			data-relative-label={relativeLabel}
			tabindex={0}
			aria-label={`${formattedDate}、${relativeLabel}`}
		>
			{formattedDate}
		</time>
	);
};
