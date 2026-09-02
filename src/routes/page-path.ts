import { isUlidCategory, normalizeUlid } from "@/lib/visibility";
import { parsePagePath } from "@/services/pipeline";

export function parseAndNormalize(pagePath: string): [string, string] {
	const [category, unixName] = parsePagePath(pagePath);
	return [category, isUlidCategory(category) ? normalizeUlid(unixName) : unixName];
}

export function routeSuffix(path: string, marker: string): string | null {
	const index = path.indexOf(marker);
	if (index < 0) return null;
	const suffix = path.slice(index + marker.length);
	return suffix || null;
}

export function strictPagePath(suffix: string | null): string | null {
	if (!suffix || suffix.includes("/")) return null;
	return suffix;
}
