import { diffArrays, diffLines } from "diff";
import { $, escapeAttr, escapeHtml, setHtml } from "./dom";
import { buildPreviewRequest } from "./preview";

const HISTORY_PAGE_SIZE = 20;

type HistoryDependencies = {
	injectStyles: (styles: string[]) => void;
	initRuntime: () => void;
	loadPage: (path: string) => void | Promise<void>;
	getRenderedPagePath: () => string | null;
};

type RevisionResponse = {
	revision_number: number;
	title: string;
	source: string;
	comment: string | null;
	created_by: number | null;
	created_by_name: string | null;
	created_by_unix_name: string | null;
	created_at: string | null;
	page_path: string;
	tags: string[];
};

type HistoryRevision = {
	revisionNumber: number;
	title: string;
	comment: string;
	createdAt: string;
	createdBy: number | null;
	createdByName: string | null;
	createdByUnixName: string | null;
};

type HistoryState = {
	path: string;
	revisions: HistoryRevision[];
	currentRevision: number;
	canEdit: boolean;
	page: number;
};

type DiffChange<T> = {
	value: T;
	added?: boolean;
	removed?: boolean;
};

type SegmenterLike = {
	segment(input: string): Iterable<{ segment: string }>;
};

let currentHistory: HistoryState | null = null;
let deps: HistoryDependencies | null = null;

export function initHistory(dependencies: HistoryDependencies) {
	deps = dependencies;
}

export function clearHistoryState() {
	currentHistory = null;
}

async function fetchRevision(path: string, num: number): Promise<RevisionResponse | null> {
	const res = await fetch(`/api/page-revision/${path}/r/${num}`);
	if (!res.ok) return null;
	return (await res.json()) as RevisionResponse;
}

function openHistorySubarea(content: string) {
	const sub = $("#history-subarea");
	if (!sub) return;
	sub.style.display = "block";
	setHtml(
		sub,
		`<a href="javascript:;" class="action-area-close" id="btn-close-subarea">close</a>` + content,
	);
	$("#btn-close-subarea")?.addEventListener("click", () => {
		sub.style.display = "none";
		setHtml(sub, "");
	});
}

export async function showRevisionView(path: string, num: number) {
	const data = await fetchRevision(path, num);
	if (!data) {
		openHistorySubarea("<p>Failed to load revision.</p>");
		return;
	}

	const previewRes = await fetch("/api/preview", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: window.location.origin },
		body: JSON.stringify(
			buildPreviewRequest(data.source, data.tags, {
				mode: "revision",
				pagePath: data.page_path,
				getRenderedPagePath: () => deps?.getRenderedPagePath() ?? null,
			}),
		),
	});
	const rendered = previewRes.ok
		? ((await previewRes.json()) as { html: string; styles: string[] })
		: { html: `<pre>${escapeHtml(data.source)}</pre>`, styles: [] };

	const dateStr = data.created_at
		? new Date(data.created_at + "Z").toLocaleString("ja-JP", {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			})
		: "";
	const userDisplay = data.created_by_name
		? `<span class="printuser">${escapeHtml(data.created_by_name)}</span>`
		: data.created_by !== null
			? `user #${data.created_by}`
			: "(unknown)";

	const versionInfo =
		`<div id="page-version-info">` +
		`<table><tbody>` +
		`<tr><td>Revision no.:</td><td>${data.revision_number}</td></tr>` +
		`<tr><td>Date created:</td><td>${escapeHtml(dateStr)}</td></tr>` +
		`<tr><td>By:</td><td>${userDisplay}</td></tr>` +
		`<tr><td>Page name:</td><td>${escapeHtml(data.page_path)}</td></tr>` +
		(data.comment ? `<tr><td>Comment:</td><td>${escapeHtml(data.comment)}</td></tr>` : "") +
		`</tbody></table>` +
		`<a href="javascript:;" id="btn-close-version-info">Close this box</a>` +
		`</div>`;

	deps?.injectStyles(rendered.styles);
	const pageTitle = $("#page-title");
	setHtml(pageTitle, data.title ? `<span>${escapeHtml(data.title)}</span>` : "");
	pageTitle?.toggleAttribute("hidden", !data.title);
	setHtml($("#page-content"), versionInfo + rendered.html);
	deps?.initRuntime();
	$("#btn-close-version-info")?.addEventListener("click", () => {
		const info = document.getElementById("page-version-info");
		if (info) info.style.display = "none";
	});
}

export async function showRevisionSource(path: string, num: number) {
	const data = await fetchRevision(path, num);
	if (!data) {
		openHistorySubarea("<p>Failed to load revision.</p>");
		return;
	}
	openHistorySubarea(
		`<h2>Page source for revision no. ${num}</h2>` +
			(data.comment ? `<p><em>${escapeHtml(data.comment)}</em></p>` : "") +
			`<div class="page-source"><pre>${escapeHtml(data.source)}</pre></div>`,
	);
}

function formatRevisionDate(value: string | null | undefined, withTime: boolean): string {
	if (!value) return "";
	return new Date(value + "Z").toLocaleString("ja-JP", {
		year: "numeric",
		month: "short",
		day: "numeric",
		...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
	});
}

function historyDefaultSelection(
	revisions: HistoryRevision[],
	currentRevision: number,
): {
	from: number;
	to: number;
} {
	const sorted = [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
	const to =
		sorted.find((r) => r.revisionNumber === currentRevision)?.revisionNumber ??
		sorted[0]?.revisionNumber ??
		0;
	const from =
		sorted.find((r) => r.revisionNumber < to)?.revisionNumber ??
		sorted.find((r) => r.revisionNumber !== to)?.revisionNumber ??
		to;
	return { from, to };
}

function renderHistoryPager(state: HistoryState, totalPages: number): string {
	if (totalPages <= 1) return "";

	const pageLinks: string[] = [`<span class="pager-no">page ${state.page} of ${totalPages}</span>`];
	if (state.page > 1) {
		pageLinks.push(
			`<span class="target"><a href="javascript:;" data-action="history-page"` +
				` data-path="${escapeAttr(state.path)}" data-page="${state.page - 1}">« previous</a></span>`,
		);
	}
	for (let i = 1; i <= totalPages; i += 1) {
		if (i === state.page) {
			pageLinks.push(`<span class="current">${i}</span>`);
		} else {
			pageLinks.push(
				`<span class="target"><a href="javascript:;" data-action="history-page"` +
					` data-path="${escapeAttr(state.path)}" data-page="${i}">${i}</a></span>`,
			);
		}
	}
	if (state.page < totalPages) {
		pageLinks.push(
			`<span class="target"><a href="javascript:;" data-action="history-page"` +
				` data-path="${escapeAttr(state.path)}" data-page="${state.page + 1}">next »</a></span>`,
		);
	}
	return `<div class="pager">${pageLinks.join("")}</div>`;
}

function renderHistoryRows(state: HistoryState): string {
	const sorted = [...state.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
	const start = (state.page - 1) * HISTORY_PAGE_SIZE;
	const pageRevisions = sorted.slice(start, start + HISTORY_PAGE_SIZE);
	let selection = historyDefaultSelection(state.revisions, state.currentRevision);
	if (
		!pageRevisions.some((r) => r.revisionNumber === selection.from) ||
		!pageRevisions.some((r) => r.revisionNumber === selection.to)
	) {
		selection = {
			to: pageRevisions[0]?.revisionNumber ?? 0,
			from: pageRevisions[1]?.revisionNumber ?? pageRevisions[0]?.revisionNumber ?? 0,
		};
	}

	return pageRevisions
		.map((r) => {
			const date = formatRevisionDate(r.createdAt, false);
			const userDisplay = r.createdByName
				? `<span class="printuser">${escapeHtml(r.createdByName)}</span>`
				: r.createdBy !== null
					? `user #${r.createdBy}`
					: "";
			const revertLink =
				state.canEdit && r.revisionNumber !== state.currentRevision
					? ` <a title="" href="javascript:;" data-action="revert-revision"` +
						` data-path="${escapeAttr(state.path)}" data-rev="${r.revisionNumber}">R</a>`
					: "";
			return (
				`<tr id="revision-row-${r.revisionNumber}">` +
				`<td>${r.revisionNumber}.</td>` +
				`<td style="width: 5em">` +
				`<input type="radio" name="history-from" value="${r.revisionNumber}"` +
				(r.revisionNumber === selection.from ? ` checked="checked"` : "") +
				`>` +
				`<input type="radio" name="history-to" value="${r.revisionNumber}"` +
				(r.revisionNumber === selection.to ? ` checked="checked"` : "") +
				`>` +
				`</td>` +
				`<td><span class="spantip" title="" style="cursor: help;">S</span></td>` +
				`<td style="width: 5em" class="optionstd">` +
				`<a title="" href="javascript:;" data-action="view-revision"` +
				` data-path="${escapeAttr(state.path)}" data-rev="${r.revisionNumber}">V</a> ` +
				`<a title="" href="javascript:;" data-action="source-revision"` +
				` data-path="${escapeAttr(state.path)}" data-rev="${r.revisionNumber}">S</a>` +
				revertLink +
				`</td>` +
				`<td style="width: 15em">${userDisplay}</td>` +
				`<td style="padding: 0 0.5em; width: 7em;">${escapeHtml(date)}</td>` +
				`<td style="font-size: 90%">${escapeHtml(r.comment ?? "")}</td>` +
				`</tr>`
			);
		})
		.join("");
}

function renderHistoryActionArea(state: HistoryState): string {
	const sorted = [...state.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
	const totalPages = Math.max(1, Math.ceil(sorted.length / HISTORY_PAGE_SIZE));
	state.page = Math.min(Math.max(1, state.page), totalPages);
	const pager = renderHistoryPager(state, totalPages);
	return (
		`<a href="javascript:;" class="action-area-close btn btn-danger" id="btn-close-action">` +
		`<i class="icon-remove"></i> Close</a>` +
		`<h1>Page history of changes</h1>` +
		`<form id="history-form-1" onsubmit="return false;">` +
		`<div class="buttons">` +
		`<input type="button" class="btn btn-default btn-sm" value="Compare versions"` +
		` name="compare" id="history-compare-button" data-action="compare-revisions"` +
		` data-path="${escapeAttr(state.path)}">` +
		`</div>` +
		`<div id="revision-list">` +
		pager +
		`<table class="page-history"><tbody>` +
		`<tr><td>rev.</td><td>&nbsp;</td><td>flags</td><td>actions</td><td>by</td><td>date</td><td>comments</td></tr>` +
		renderHistoryRows(state) +
		`</tbody></table>` +
		pager +
		`</div>` +
		`</form>` +
		`<div id="history-subarea" style="display: none;"></div>`
	);
}

function closeHistoryActionArea(actionArea: HTMLElement) {
	clearHistoryState();
	setHtml(actionArea, "");
}

export async function showHistory(path: string) {
	const actionArea = $("#action-area");
	if (!actionArea) return;

	const res = await fetch(`/api/page-history/${path}`);
	if (!res.ok) {
		setHtml(actionArea, "<p>Failed to load history.</p>");
		return;
	}

	const data = (await res.json()) as {
		revisions: HistoryRevision[];
		currentRevision?: number;
		canEdit?: boolean;
	};
	const maxRevision = Math.max(...data.revisions.map((r) => r.revisionNumber), 0);
	currentHistory = {
		path,
		revisions: data.revisions,
		currentRevision: data.currentRevision ?? maxRevision,
		canEdit: data.canEdit ?? false,
		page: 1,
	};

	actionArea.style.display = "block";
	setHtml(actionArea, renderHistoryActionArea(currentHistory));
	$("#btn-close-action")?.addEventListener("click", () => closeHistoryActionArea(actionArea));
}

export function rerenderHistoryPage(page: number) {
	if (!currentHistory) return;
	currentHistory.page = page;
	const actionArea = $("#action-area");
	if (!actionArea) return;
	setHtml(actionArea, renderHistoryActionArea(currentHistory));
	$("#btn-close-action")?.addEventListener("click", () => closeHistoryActionArea(actionArea));
}

function getSelectedHistoryRevision(name: string): number | null {
	const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
	if (!input) return null;
	const value = Number(input.value);
	return Number.isNaN(value) ? null : value;
}

function createSourceDiffSegmenter(): SegmenterLike | null {
	const Segmenter = (
		Intl as typeof Intl & {
			Segmenter?: new (
				locales?: string | string[],
				options?: { granularity: "word" | "grapheme" | "sentence" },
			) => SegmenterLike;
		}
	).Segmenter;
	return Segmenter ? new Segmenter(["ja", "en"], { granularity: "word" }) : null;
}

const sourceDiffSegmenter = createSourceDiffSegmenter();

function tokenizeSourceLine(line: string): string[] {
	if (!line) return [];
	if (!sourceDiffSegmenter) return Array.from(line);
	const tokens: string[] = [];
	for (const part of sourceDiffSegmenter.segment(line)) {
		const pieces = part.segment.split(/(\s+)/u).filter((piece) => piece.length > 0);
		tokens.push(...pieces);
	}
	return tokens.length > 0 ? tokens : Array.from(line);
}

function renderInlineTokenDiff(oldLine: string, newLine: string, side: "old" | "new"): string {
	const tokenDiff = diffArrays(
		tokenizeSourceLine(oldLine),
		tokenizeSourceLine(newLine),
	) as DiffChange<string[]>[];
	return tokenDiff
		.map((change) => {
			if (side === "old" && change.added) return "";
			if (side === "new" && change.removed) return "";
			const value = escapeHtml(change.value.join(""));
			if (side === "old" && change.removed) {
				return `<span class="diff-inline-removed">${value}</span>`;
			}
			if (side === "new" && change.added) {
				return `<span class="diff-inline-added">${value}</span>`;
			}
			return value;
		})
		.join("");
}

function splitDiffLines(value: string): string[] {
	if (!value) return [];
	const lines = value.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function lineSimilarity(oldLine: string, newLine: string): number {
	if (oldLine === newLine) return 1;
	if (oldLine.trim() === "" || newLine.trim() === "") return 0;
	const oldTokens = tokenizeSourceLine(oldLine);
	const newTokens = tokenizeSourceLine(newLine);
	const tokenDiff = diffArrays(oldTokens, newTokens) as DiffChange<string[]>[];
	const unchangedLength = tokenDiff
		.filter((change) => !change.added && !change.removed)
		.reduce((sum, change) => sum + change.value.join("").length, 0);
	return unchangedLength / Math.max(oldLine.length, newLine.length);
}

function shouldInlinePairLines(oldLine: string, newLine: string): boolean {
	return lineSimilarity(oldLine, newLine) >= 0.35;
}

function shouldInlinePairBlock(oldLines: string[], newLines: string[]): boolean {
	const comparable = Math.min(oldLines.length, newLines.length);
	if (comparable === 0) return false;
	const pairable = Array.from({ length: comparable }).filter((_, i) =>
		shouldInlinePairLines(oldLines[i], newLines[i]),
	).length;
	return pairable / comparable >= 0.45;
}

function renderUnifiedEqualRows(
	lines: string[],
	oldLine: { value: number },
	newLine: { value: number },
): string {
	const rows: string[] = [];
	const renderLine = (line: string) => {
		rows.push(
			`<tr class="diff-line-context"><td>${oldLine.value}</td><td>${newLine.value}</td>` +
				`<td class="diff-marker">&nbsp;</td><td><code>${escapeHtml(line) || "&nbsp;"}</code></td></tr>`,
		);
		oldLine.value += 1;
		newLine.value += 1;
	};
	if (lines.length <= 8) {
		lines.forEach(renderLine);
		return rows.join("");
	}
	lines.slice(0, 3).forEach(renderLine);
	const omitted = lines.length - 6;
	oldLine.value += omitted;
	newLine.value += omitted;
	rows.push(
		`<tr class="diff-line-omitted"><td>...</td><td>...</td><td></td>` +
			`<td>${omitted} unchanged lines</td></tr>`,
	);
	lines.slice(-3).forEach(renderLine);
	return rows.join("");
}

function renderUnifiedDiff(oldSource: string, newSource: string): string {
	const changes = diffLines(oldSource, newSource) as DiffChange<string>[];
	const rows: string[] = [];
	const oldLine = { value: 1 };
	const newLine = { value: 1 };
	const renderRemoved = (line: string, pairedWith?: string) => {
		rows.push(
			`<tr class="diff-line-removed"><td>${oldLine.value}</td><td></td>` +
				`<td class="diff-marker">-</td><td><code>${
					pairedWith === undefined
						? escapeHtml(line) || "&nbsp;"
						: renderInlineTokenDiff(line, pairedWith, "old") || "&nbsp;"
				}</code></td></tr>`,
		);
		oldLine.value += 1;
	};
	const renderAdded = (line: string, pairedWith?: string) => {
		rows.push(
			`<tr class="diff-line-added"><td></td><td>${newLine.value}</td>` +
				`<td class="diff-marker">+</td><td><code>${
					pairedWith === undefined
						? escapeHtml(line) || "&nbsp;"
						: renderInlineTokenDiff(pairedWith, line, "new") || "&nbsp;"
				}</code></td></tr>`,
		);
		newLine.value += 1;
	};

	for (let i = 0; i < changes.length; i += 1) {
		const change = changes[i];
		const lines = splitDiffLines(change.value);
		if (!change.added && !change.removed) {
			rows.push(renderUnifiedEqualRows(lines, oldLine, newLine));
			continue;
		}
		const next = changes[i + 1];
		if (change.removed && next?.added) {
			const oldLines = splitDiffLines(change.value);
			const newLines = splitDiffLines(next.value);
			if (!shouldInlinePairBlock(oldLines, newLines)) {
				oldLines.forEach((line) => renderRemoved(line));
				newLines.forEach((line) => renderAdded(line));
			} else {
				const max = Math.max(oldLines.length, newLines.length);
				for (let j = 0; j < max; j += 1) {
					if (oldLines[j] !== undefined) {
						const paired = newLines[j];
						renderRemoved(
							oldLines[j],
							paired !== undefined && shouldInlinePairLines(oldLines[j], paired)
								? paired
								: undefined,
						);
					}
					if (newLines[j] !== undefined) {
						const paired = oldLines[j];
						renderAdded(
							newLines[j],
							paired !== undefined && shouldInlinePairLines(paired, newLines[j])
								? paired
								: undefined,
						);
					}
				}
			}
			i += 1;
			continue;
		}
		if (change.removed) {
			lines.forEach((line) => renderRemoved(line));
		} else {
			lines.forEach((line) => renderAdded(line));
		}
	}

	return (
		`<table class="source-unified-diff"><tbody>` +
		(rows.join("") ||
			`<tr class="diff-line-context"><td></td><td></td><td></td><td>No source changes.</td></tr>`) +
		`</tbody></table>`
	);
}

function renderCompareDate(value: string | null): string {
	const dateText = formatRevisionDate(value, true);
	if (!value) return "";
	const timestamp = Math.floor(new Date(`${value}Z`).getTime() / 1000);
	return (
		`<span class="odate time_${timestamp} format_%25e%20%25b%20%25Y%2C%20%25H%3A%25M%7Cagohover"` +
		` style="cursor: help; display: inline;">${escapeHtml(dateText)}</span>`
	);
}

function renderRevisionComparison(from: RevisionResponse, to: RevisionResponse): string {
	const compareTable =
		`<table class="page-compare"><tbody>` +
		`<tr><th></th><th>Revision ${from.revision_number}</th><th>Revision ${to.revision_number}</th></tr>` +
		`<tr><td>Created on:</td><td>${renderCompareDate(from.created_at)}</td>` +
		`<td>${renderCompareDate(to.created_at)}</td></tr>` +
		`<tr><td>By:</td><td>${escapeHtml(from.created_by_name ?? "")}</td>` +
		`<td>${escapeHtml(to.created_by_name ?? "")}</td></tr>` +
		(from.title !== to.title
			? `<tr><td>Title:</td><td>${escapeHtml(from.title)}</td><td>${escapeHtml(to.title)}</td></tr>`
			: "") +
		`</tbody></table>`;

	return (
		`<h2>Page revisions comparison</h2>` +
		`<div class="diff-box">` +
		compareTable +
		`<h3>Source change:</h3>` +
		`<div class="source-diff-unified">` +
		renderUnifiedDiff(from.source, to.source) +
		`</div>` +
		`</div>`
	);
}

export async function showRevisionCompare(path: string) {
	const fromNum = getSelectedHistoryRevision("history-from");
	const toNum = getSelectedHistoryRevision("history-to");
	if (fromNum === null || toNum === null) {
		window.alert("Select two revisions to compare.");
		return;
	}
	if (fromNum === toNum) {
		window.alert("Select two different revisions.");
		return;
	}
	const [from, to] = await Promise.all([fetchRevision(path, fromNum), fetchRevision(path, toNum)]);
	if (!from || !to) {
		openHistorySubarea("<p>Failed to load revisions.</p>");
		return;
	}
	openHistorySubarea(renderRevisionComparison(from, to));
}

export async function revertRevision(path: string, rev: number) {
	if (!window.confirm(`Revert this page to revision ${rev}?`)) return;
	const res = await fetch(`/api/page-revert/${path}/r/${rev}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: window.location.origin },
		body: JSON.stringify({}),
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
			error?: string;
		};
		window.alert(`Revert failed: ${err.error ?? "unknown error"}`);
		return;
	}
	const data = (await res.json()) as { new_path?: string };
	const actionArea = $("#action-area");
	if (actionArea) setHtml(actionArea, "");
	await deps?.loadPage(data.new_path ?? path);
}
