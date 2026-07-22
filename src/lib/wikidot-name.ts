export function normalizeWikidotCategoryName(value: string): string {
	const lower = value.trim().toLowerCase();
	const leadingUnderscore = lower.startsWith("_");
	const body = lower
		.replace(/^_+/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	return leadingUnderscore ? `_${body}` : body;
}
