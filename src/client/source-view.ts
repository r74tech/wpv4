import { extractIncludeReferences } from "@wdprlib/parser";
import { formatIncludeSourcePath } from "../lib/include-reference";
import { escapeAttr, escapeHtml } from "./dom";

const INCLUDE_TARGET_PATTERN = /^(\[\[include\s+)([^\s|\]]+)/i;
const INCLUDE_OPEN_PATTERN = /^\[\[include\s/gim;
const MAX_INCLUDE_SCAN_WORK = 10_000_000;

function isIncludeScanBounded(source: string): boolean {
	INCLUDE_OPEN_PATTERN.lastIndex = 0;
	let openerCount = 0;
	while (INCLUDE_OPEN_PATTERN.exec(source) !== null) {
		openerCount++;
		if (source.length * openerCount > MAX_INCLUDE_SCAN_WORK) return false;
	}
	return true;
}

/** Render escaped source with recognized include targets linked to their source views. */
export function renderSourceWithIncludeLinks(source: string): string {
	const references = isIncludeScanBounded(source) ? extractIncludeReferences(source) : [];
	let cursor = 0;
	let html = "";

	for (const reference of references) {
		html += escapeHtml(source.slice(cursor, reference.start));
		const directive = source.slice(reference.start, reference.end);
		const match = INCLUDE_TARGET_PATTERN.exec(directive);
		const pagePath = formatIncludeSourcePath(reference.location);

		if (!match || !pagePath) {
			html += escapeHtml(directive);
			cursor = reference.end;
			continue;
		}

		const targetStart = match[1].length;
		const targetEnd = targetStart + match[2].length;
		html += escapeHtml(directive.slice(0, targetStart));
		html +=
			`<a href="javascript:;" data-action="source" data-include-source data-path="${escapeAttr(pagePath)}">` +
			escapeHtml(directive.slice(targetStart, targetEnd)) +
			"</a>";
		html += escapeHtml(directive.slice(targetEnd));
		cursor = reference.end;
	}

	return html + escapeHtml(source.slice(cursor));
}
