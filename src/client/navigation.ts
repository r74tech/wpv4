export function normalizePagePath(path: string): string {
	const withoutFragment = path.split("#", 1)[0] ?? "";
	const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
	const normalized = withoutQuery.replace(/^\/+|\/+$/g, "");
	if (!normalized) return "main";
	try {
		return decodeURI(normalized);
	} catch {
		return normalized;
	}
}

export function shouldReloadPage(renderedPagePath: string | null, nextPagePath: string): boolean {
	if (renderedPagePath === null) return true;
	return normalizePagePath(renderedPagePath) !== normalizePagePath(nextPagePath);
}
