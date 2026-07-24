import { initWdprRuntime } from "@wdprlib/runtime";
import type { WdprRuntime } from "@wdprlib/runtime";
import { $, escapeAttr, escapeHtml, setHtml } from "./dom";
import { normalizePagePath, shouldReloadPage } from "./navigation";
import { buildPreviewRequest, isPreviewCategory } from "./preview";
import { commitPagePresentation } from "./page-presentation";
import { formatDocumentTitle } from "../lib/document-title";
import {
	renderLoginStatus,
	renderPageOptions,
	renderSidebarActions,
	type PageActionState,
} from "../lib/shell-ui";
import {
	clearHistoryState,
	initHistory,
	rerenderHistoryPage,
	revertRevision,
	showHistory,
	showRevisionCompare,
	showRevisionSource,
	showRevisionView,
} from "./history";

// --- 型定義 ---

type PageResponse = PageActionState & {
	title: string;
	html: string;
	styles: string[];
	tags: string[];
};

type ReferencedBy = {
	category: string;
	unix_name: string;
	title: string;
};

// --- 状態 ---

let runtime: WdprRuntime | null = null;
let authenticated = false;
let renderedPagePath: string | null = null;

// --- ページ読み込み ---

function clearActionArea() {
	// /new SSR で `data-new-type` が、 showEditor で `data-edit-path` が action-area に
	// 残っていると、 SPA 遷移後も古いフォームと dataset が見えて setupPageForm() が
	// 誤って新規作成 (POST /api/page/new) や旧 path への PUT を実行してしまう。
	// ページ遷移時は必ずクリアする。
	const area = $("#action-area");
	if (!area) return;
	setHtml(area, "");
	area.removeAttribute("data-new-type");
	area.removeAttribute("data-edit-path");
	area.removeAttribute("data-base-rev");
	area.style.display = "";
	clearHistoryState();
}

// URL パス（例: "private:01ks.../offset/1/page2_limit/1"）から
// Wikidot 互換 URL パラメータ部分を切り捨て、ページ識別子（先頭の "/" セグメント）だけ
// を返す。 Edit / data-path 等の "そのページを特定する文字列" には常にこちらを使う。
function cleanPagePath(path: string): string {
	const cleaned = path.replace(/^\/+|\/+$/g, "");
	const first = cleaned.split("/")[0] ?? "";
	return first || "main";
}

async function loadPage(path: string) {
	renderedPagePath = normalizePagePath(path);
	clearActionArea();
	const pageContent = $("#page-content");
	const pageTitle = $("#page-title");
	const replaceTitle = (html: string, hidden: boolean) => {
		setHtml(pageTitle, html);
		pageTitle?.toggleAttribute("hidden", hidden);
	};
	const resetDocumentTitle = () => {
		document.title = formatDocumentTitle("");
	};
	// API には URL params 付きの full path を投げる（ListPages の @URL|... 解決に必要）。
	// Edit / Source / History / data-path 等の表示用には clean path を使う。
	const cleanPath = cleanPagePath(path);

	try {
		const res = await fetch(`/api/page/${path}`);
		if (!res.ok) {
			if (res.status === 404) {
				injectStyles([]);
				resetDocumentTitle();
				replaceTitle("", true);
				setHtml(pageContent, "<p>ページが見つかりません。</p>");
				updatePageTags([]);
			} else if (res.status === 403) {
				injectStyles([]);
				resetDocumentTitle();
				replaceTitle("<span>Forbidden</span>", false);
				setHtml(pageContent, "<p>This page is private.</p>");
				updatePageTags([]);
			} else {
				throw new Error(`HTTP ${res.status}`);
			}
			clearPageOptions();
			return;
		}

		const data: PageResponse = await res.json();
		commitPagePresentation(data, {
			replaceStyles: injectStyles,
			replaceDocumentTitle: (title) => {
				document.title = title;
			},
			replaceTitle,
			replaceContent: (html) => setHtml(pageContent, html),
			replaceTags: updatePageTags,
		});
		initRuntime();
		updatePageOptions(cleanPath, data);
	} catch (err) {
		console.error("Failed to load page:", err);
		injectStyles([]);
		resetDocumentTitle();
		replaceTitle("", true);
		setHtml(pageContent, "<p>ページの読み込みに失敗しました。</p>");
		updatePageTags([]);
		clearPageOptions();
	}
}

function injectStyles(styles: string[]) {
	const existing = document.getElementById("wdpr-page-styles");
	existing?.remove();

	if (styles.length > 0) {
		const styleEl = document.createElement("style");
		styleEl.id = "wdpr-page-styles";
		styleEl.textContent = styles.join("\n");
		document.head.appendChild(styleEl);
	}
}

function initRuntime() {
	runtime?.destroy();
	runtime = initWdprRuntime({ root: $("#page-content") ?? undefined });
}

// --- ページオプション ---

function clearPageOptions() {
	const options = $(".page-options-bottom");
	if (options) setHtml(options, "");
}

function updatePageOptions(path: string, page: PageResponse) {
	const options = $(".page-options-bottom");
	if (!options) return;
	setHtml(options, renderPageOptions(authenticated, path, page));
}

function renderPageTags(tags: string[]): string {
	if (tags.length === 0) return "";
	return (
		`<div class="page-tags"><span>` +
		tags
			.map(
				(tag) =>
					`<a href="/system:page-tags/tag/${encodeURIComponent(tag)}#pages">${escapeHtml(tag)}</a>`,
			)
			.join("") +
		`</span></div>`
	);
}

function updatePageTags(tags: string[]) {
	const existing = document.querySelector("#main-content > .page-tags");
	existing?.remove();
	if (tags.length === 0) return;
	$("#page-content")?.insertAdjacentHTML("afterend", renderPageTags(tags));
}

// --- ナビゲーション ---

function navigateTo(path: string) {
	const resolved = path || "main";
	history.pushState(null, "", `/${resolved}`);
	loadPage(resolved);
}

function getPagePathFromUrl(): string | null {
	const path = window.location.pathname.slice(1); // 先頭の / を除去
	// auth系パスはページではない
	if (path.startsWith("auth/")) return null;
	// /new は新規作成画面でSSR完結（loadPage を起動しない）
	if (path === "new" || path.startsWith("new?")) return null;
	return path || "main";
}

// --- サイドバー・トップバー ---

async function loadSidebar() {
	const sidebar = $("#side-bar");
	if (!sidebar) return;
	// SSRで既にコンテンツがあればスキップ
	if (sidebar.children.length > 1) return;
	try {
		const res = await fetch("/api/sidebar");
		const data = (await res.json()) as { html: string };
		const actions = sidebar.querySelector("#side-bar-actions");
		const actionsHtml = actions ? actions.outerHTML : "";
		sidebar.innerHTML = actionsHtml + (data.html || "");
	} catch {
		// サイドバーなしでも動作する
	}
}

async function loadTopbar() {
	const topbar = $("#top-bar");
	if (!topbar) return;
	// SSRで既にコンテンツがあればスキップ
	if (topbar.innerHTML.trim()) return;
	try {
		const res = await fetch("/api/topbar");
		const data = (await res.json()) as { html: string };
		setHtml(topbar, data.html || "");
	} catch {
		// トップバーなしでも動作する
	}
}

// --- 認証状態 ---

function setupAccountOptions() {
	const topBtn = $("#account-topbutton");
	const optionsDiv = $("#account-options");
	if (!topBtn || !optionsDiv) return;

	optionsDiv.style.display = "none";
	topBtn.addEventListener("click", () => {
		optionsDiv.style.display = optionsDiv.style.display === "none" ? "block" : "none";
	});
}

function showSignedOutStatus() {
	const loginStatus = $("#login-status");
	if (!loginStatus) return;

	authenticated = false;
	setHtml(loginStatus, renderLoginStatus(null));
	updateSidebarActions();
}

function updateSidebarActions() {
	const actions = $("#side-bar-actions");
	if (!actions) return;
	setHtml(actions, renderSidebarActions(authenticated));
}

// --- エディタ ---

// /new SSR と同じ Wikidot 互換フォーム HTML を生成する。
// data-edit-path + data-base-rev を action-area に付けて編集モードを識別する。
function renderEditPageForm(opts: {
	heading: string;
	titleValue: string;
	sourceValue: string;
	tagsValue: string;
	commentValue: string;
}): string {
	return (
		`<h1>${escapeHtml(opts.heading)}</h1>` +
		`<div>` +
		`<form id="edit-page-form" onsubmit="return false;">` +
		`<table class="form" style="margin: 0.5em auto 1em 0">` +
		`<tbody><tr>` +
		`<td>Title of the page:</td>` +
		`<td><input class="text" id="edit-page-title" name="title" type="text"` +
		` value="${escapeAttr(opts.titleValue)}" size="35" maxlength="128"` +
		` style="font-weight: bold; font-size: 130%;" /></td>` +
		`</tr></tbody>` +
		`</table>` +
		`<div>` +
		`<textarea id="edit-page-textarea" name="source" rows="20" cols="60" style="width: 95%;">` +
		`${escapeHtml(opts.sourceValue)}</textarea>` +
		`</div>` +
		`<div class="edit-help-34">` +
		`Help: <a href="http://www.wikidot.com/doc:quick-reference" target="_blank" rel="noopener">wiki text quick reference</a>` +
		`</div>` +
		`<table class="edit-page-bottomtable" style="padding: 2px 0; border: none;">` +
		`<tbody><tr>` +
		`<td style="border: none; padding: 0 5px;">` +
		`<div>Tags (space separated):<br />` +
		`<input type="text" id="edit-page-tags" name="tags" value="${escapeAttr(opts.tagsValue)}" />` +
		`</div>` +
		`<div style="margin-top: 0.5em;">Short description of changes:<br />` +
		`<textarea id="edit-page-comments" name="comments" rows="2" cols="40">${escapeHtml(opts.commentValue)}</textarea>` +
		`</div>` +
		`</td>` +
		`</tr></tbody>` +
		`</table>` +
		`<div class="buttons alignleft">` +
		`<a href="javascript:;" class="btn btn-danger" id="edit-cancel-button">Cancel</a> ` +
		`<input type="button" id="edit-preview-button" class="btn btn-default" value="Preview" /> ` +
		`<input type="button" id="edit-save-button" class="btn btn-primary" value="Save" />` +
		`</div>` +
		`</form>` +
		`</div>`
	);
}

async function showEditor(path: string) {
	const actionArea = $("#action-area");
	if (!actionArea) return;

	const res = await fetch(`/api/page-source/${path}`);
	let title = "";
	let source = "";
	let tags: string[] = [];
	let revisionCount: number | null = null;

	if (res.ok) {
		const data = (await res.json()) as {
			title: string;
			source: string;
			tags: string[];
			revision_count: number;
		};
		title = data.title;
		source = data.source;
		tags = data.tags;
		revisionCount = data.revision_count;
	}

	// /new と同じハンドラ群を再利用するため、 action-area に data-edit-path を付与
	actionArea.style.display = "block";
	actionArea.dataset.editPath = path;
	actionArea.dataset.baseRev = revisionCount === null ? "" : String(revisionCount);
	delete actionArea.dataset.newType;

	setHtml(
		actionArea,
		renderEditPageForm({
			heading: `Edit page: ${path}`,
			titleValue: title,
			sourceValue: source,
			tagsValue: tags.join(" "),
			commentValue: "",
		}),
	);

	setupPageForm();
}

// --- ソース表示 ---

async function showSource(path: string) {
	const actionArea = $("#action-area");
	if (!actionArea) return;

	const res = await fetch(`/api/page-source/${path}`);
	if (!res.ok) {
		setHtml(actionArea, "<p>Failed to load source.</p>");
		return;
	}

	const data = (await res.json()) as { source: string };
	setHtml(
		actionArea,
		`<a href="javascript:;" class="action-area-close" id="btn-close-action">Close</a>` +
			`<h1>Page Source</h1>` +
			`<div class="page-source"><pre>${escapeHtml(data.source)}</pre></div>`,
	);
	$("#btn-close-action")?.addEventListener("click", () => setHtml(actionArea, ""));
}

// --- イベントハンドラ ---

function setupEventHandlers() {
	// リンククリック: SPA遷移
	document.addEventListener("click", (e) => {
		const target = e.target as HTMLElement;
		const anchor = target.closest("a");
		if (!anchor) return;

		// data-action付きリンクはSPAナビゲーションではなく別ハンドラで処理
		if (anchor.hasAttribute("data-action")) return;

		const href = anchor.getAttribute("href");
		if (!href || href.startsWith("http") || href.startsWith("javascript:")) return;

		// auth/user/new系はSPA遷移させず通常のナビゲーション
		if (
			href.startsWith("/auth/") ||
			href.startsWith("/user/") ||
			href === "/new" ||
			href.startsWith("/new?") ||
			href.startsWith("/new/")
		)
			return;

		// 内部リンク
		if (href.startsWith("/")) {
			e.preventDefault();
			const path = href.slice(1);
			navigateTo(path);
		}
	});

	// ブラウザの戻る/進む
	window.addEventListener("popstate", () => {
		const path = getPagePathFromUrl();
		if (path && shouldReloadPage(renderedPagePath, path)) loadPage(path);
	});

	// ページオプション + ログアウト + アクション閉じる
	document.addEventListener("click", async (e) => {
		const target = e.target as HTMLElement;

		// data-action付きリンク（編集・履歴・ソース・toggle）
		const actionAnchor = target.closest("[data-action]") as HTMLElement | null;
		if (actionAnchor) {
			e.preventDefault();
			const action = actionAnchor.dataset.action;

			if (action === "toggle-visibility") {
				const ulid = actionAnchor.dataset.ulid;
				const toggleTarget = actionAnchor.dataset.target as
					| "public"
					| "share"
					| "private"
					| undefined;
				const currentPath = actionAnchor.dataset.currentPath ?? "";
				const currentCategory = actionAnchor.dataset.currentCategory as
					| "public"
					| "share"
					| "private"
					| undefined;
				if (
					ulid &&
					currentPath &&
					(currentCategory === "public" ||
						currentCategory === "share" ||
						currentCategory === "private") &&
					(toggleTarget === "public" || toggleTarget === "share" || toggleTarget === "private")
				) {
					showRenameConfirmation(ulid, currentPath, currentCategory, toggleTarget);
				}
				return;
			}

			const path = actionAnchor.dataset.path;
			if (!path) return;

			if (action === "edit") {
				showEditor(path);
			} else if (action === "history") {
				showHistory(path);
			} else if (action === "history-page") {
				const page = Number(actionAnchor.dataset.page);
				if (!Number.isNaN(page)) rerenderHistoryPage(page);
			} else if (action === "compare-revisions") {
				showRevisionCompare(path);
			} else if (action === "source") {
				showSource(path);
			} else if (action === "view-revision") {
				const rev = Number(actionAnchor.dataset.rev);
				if (!Number.isNaN(rev)) showRevisionView(path, rev);
			} else if (action === "source-revision") {
				const rev = Number(actionAnchor.dataset.rev);
				if (!Number.isNaN(rev)) showRevisionSource(path, rev);
			} else if (action === "revert-revision") {
				const rev = Number(actionAnchor.dataset.rev);
				if (!Number.isNaN(rev)) revertRevision(path, rev);
			}
			return;
		}

		// ログアウト
		if (target.id === "btn-logout") {
			await fetch("/auth/logout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
			});
			showSignedOutStatus();
			const path2 = getPagePathFromUrl();
			if (path2) loadPage(path2);
		}
	});
}

// --- visibility トグル ---

async function toggleVisibility(
	ulid: string,
	expectedCategory: "public" | "share" | "private",
	target: "public" | "share" | "private",
	force: boolean,
): Promise<void> {
	const res = await fetch(`/api/page/${ulid}/visibility`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: window.location.origin },
		body: JSON.stringify({ target, expected_category: expectedCategory, force }),
	});

	if (res.ok) {
		const data = (await res.json()) as { new_path: string };
		// 新URL（prefixが変わる）へフルロード遷移
		window.location.href = `/${data.new_path}`;
		return;
	}

	if (res.status === 409) {
		const data = (await res.json()) as {
			referenced_by?: ReferencedBy[];
			hidden_referenced_count?: number;
			include_becomes_broken?: boolean;
			list_pages_presence_changes?: boolean;
			actual_category?: string;
			error?: string;
		};
		// expected_category 不一致は別 user/tab で先に切り替わった等のレース。
		// クライアントの現値表示と DB が乖離しているので alert + reload を促す。
		if (data.actual_category) {
			window.alert(
				`${data.error ?? "Visibility changed elsewhere"} (current: ${data.actual_category})`,
			);
			window.location.reload();
			return;
		}
		// 参照警告レスポンスのみ showReferenceWarning に流す。
		// それ以外の 409（並行 UPDATE による revisionCount 競合等）は専用ハンドリング。
		const isReferenceWarning =
			Array.isArray(data.referenced_by) ||
			typeof data.hidden_referenced_count === "number" ||
			data.include_becomes_broken === true ||
			data.list_pages_presence_changes === true;
		if (!isReferenceWarning) {
			window.alert(`${data.error ?? "Conflict"}. Reload and try again.`);
			window.location.reload();
			return;
		}
		showReferenceWarning(
			ulid,
			expectedCategory,
			target,
			data.referenced_by ?? [],
			data.hidden_referenced_count ?? 0,
			{
				includeBecomesBroken: data.include_becomes_broken ?? false,
				listPagesPresenceChanges: data.list_pages_presence_changes ?? false,
			},
		);
		return;
	}

	const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
		error?: string;
	};
	window.alert(`Toggle failed: ${err.error ?? "unknown error"}`);
}

// 現 path を打ち込ませる rename 確認モーダル。
// スマホ等で ULID を手打ちするのは現実的でないため copy ボタンを併設する。
// 入力が完全一致したら Confirm が有効化され、 toggleVisibility に進む。
function showRenameConfirmation(
	ulid: string,
	currentPath: string,
	currentCategory: "public" | "share" | "private",
	target: "public" | "share" | "private",
): void {
	document.getElementById("rename-confirm-modal")?.remove();

	const newPath = `${target}:${ulid}`;
	const modal = document.createElement("div");
	modal.id = "rename-confirm-modal";
	modal.setAttribute("role", "dialog");
	modal.setAttribute("aria-modal", "true");
	modal.style.cssText =
		"position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);" +
		"z-index:1000;display:flex;align-items:center;justify-content:center;padding:1em;";
	modal.innerHTML =
		`<div style="background:#fff;padding:1.5em;max-width:560px;width:100%;` +
		`max-height:90vh;overflow:auto;border-radius:4px;">` +
		`<h3 style="margin-top:0;">Rename to make ${escapeHtml(target)}</h3>` +
		`<p>This page will move from` +
		` <code>${escapeHtml(currentPath)}</code> to <code>${escapeHtml(newPath)}</code>.</p>` +
		`<p>To confirm, paste or type the current path below.</p>` +
		`<div style="display:flex;align-items:center;gap:0.5em;margin:0.5em 0;flex-wrap:wrap;">` +
		`<code class="rename-current-path"` +
		` style="background:#f4f4f4;padding:0.4em 0.6em;border-radius:3px;` +
		`font-size:0.95em;word-break:break-all;flex:1 1 auto;">` +
		`${escapeHtml(currentPath)}</code>` +
		`<button type="button" class="btn-rename-copy btn btn-default" style="flex:0 0 auto;">` +
		`Copy</button>` +
		`</div>` +
		`<input type="text" class="rename-confirm-input"` +
		` placeholder="${escapeAttr(currentPath)}"` +
		` autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"` +
		` style="width:100%;box-sizing:border-box;padding:0.5em;font-family:monospace;` +
		`font-size:1em;margin-top:0.25em;" />` +
		`<p class="rename-confirm-hint" style="font-size:0.85em;color:#888;margin:0.4em 0 0;">` +
		`Confirm becomes active when the input matches the current path.</p>` +
		`<div style="margin-top:1em;display:flex;gap:0.5em;justify-content:flex-end;flex-wrap:wrap;">` +
		`<button type="button" class="btn-rename-cancel btn btn-default">Cancel</button>` +
		`<button type="button" class="btn-rename-confirm btn btn-primary" disabled>` +
		`Make ${escapeHtml(target)}</button>` +
		`</div>` +
		`</div>`;
	document.body.appendChild(modal);

	// モーダル内要素は modal にスコープして取得（DOM clobbering / ID 衝突回避）
	const input = modal.querySelector<HTMLInputElement>(".rename-confirm-input");
	const confirmBtn = modal.querySelector<HTMLButtonElement>(".btn-rename-confirm");
	const copyBtn = modal.querySelector<HTMLButtonElement>(".btn-rename-copy");
	const cancelBtn = modal.querySelector<HTMLButtonElement>(".btn-rename-cancel");

	const updateState = () => {
		if (!input || !confirmBtn) return;
		confirmBtn.disabled = input.value.trim() !== currentPath;
	};
	input?.addEventListener("input", updateState);
	input?.focus();

	copyBtn?.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(currentPath);
			const original = copyBtn.textContent ?? "Copy";
			copyBtn.textContent = "Copied";
			window.setTimeout(() => {
				copyBtn.textContent = original;
			}, 1500);
		} catch {
			// clipboard 権限がない環境向けフォールバック: input に流し込む
			if (input) {
				input.value = currentPath;
				updateState();
				input.focus();
			}
		}
	});

	cancelBtn?.addEventListener("click", () => modal.remove());
	confirmBtn?.addEventListener("click", async () => {
		if (confirmBtn.disabled) return;
		modal.remove();
		await toggleVisibility(ulid, currentCategory, target, false);
	});
}

function showReferenceWarning(
	ulid: string,
	expectedCategory: "public" | "share" | "private",
	target: "public" | "share" | "private",
	visible: ReferencedBy[],
	hiddenCount: number,
	impact: { includeBecomesBroken: boolean; listPagesPresenceChanges: boolean },
): void {
	// 既存モーダルがあれば消す
	document.getElementById("visibility-confirm-modal")?.remove();

	const list = visible
		.map((p) => {
			const path = p.category === "_default" ? p.unix_name : `${p.category}:${p.unix_name}`;
			return `<li><a href="/${path}" target="_blank">${escapeHtml(p.title || path)}</a> <small>(${escapeHtml(path)})</small></li>`;
		})
		.join("");
	const hiddenLine =
		hiddenCount > 0 ? `<p>...and ${hiddenCount} non-public page(s) referencing this page.</p>` : "";
	const visibleSection =
		visible.length > 0
			? `<p>This page is included in the following pages:</p><ul>${list}</ul>`
			: "";

	// 影響の説明
	const impactItems: string[] = [];
	if (impact.includeBecomesBroken) {
		impactItems.push(`include references will become <strong>cannot-be-found</strong> blocks`);
	}
	if (impact.listPagesPresenceChanges) {
		impactItems.push(
			target === "public"
				? `this page will appear in <strong>ListPages</strong> results`
				: `this page will be removed from <strong>ListPages</strong> results`,
		);
	}
	const impactSection =
		impactItems.length > 0
			? `<p>Switching to <strong>${escapeHtml(target)}</strong> means:</p><ul>${impactItems.map((s) => `<li>${s}</li>`).join("")}</ul>`
			: "";

	const modal = document.createElement("div");
	modal.id = "visibility-confirm-modal";
	modal.setAttribute("role", "dialog");
	modal.setAttribute("aria-modal", "true");
	modal.style.cssText =
		"position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;";
	modal.innerHTML =
		`<div style="background:#fff;padding:1.5em;max-width:600px;width:90%;max-height:80vh;overflow:auto;border-radius:4px;">` +
		`<h3>Make this page ${escapeHtml(target)}?</h3>` +
		impactSection +
		visibleSection +
		hiddenLine +
		`<div style="margin-top:1em;display:flex;gap:0.5em;justify-content:flex-end;">` +
		`<button type="button" class="btn-toggle-cancel">Cancel</button>` +
		`<button type="button" class="btn-toggle-force">Force ${escapeHtml(target)}</button>` +
		`</div></div>`;
	document.body.appendChild(modal);

	modal
		.querySelector<HTMLButtonElement>(".btn-toggle-cancel")
		?.addEventListener("click", () => modal.remove());
	modal
		.querySelector<HTMLButtonElement>(".btn-toggle-force")
		?.addEventListener("click", async () => {
			modal.remove();
			await toggleVisibility(ulid, expectedCategory, target, true);
		});
}

// --- 新規/編集ページフォーム共通ハンドラ ---

function readPageFormBody(): {
	title: string;
	source: string;
	tags: string[];
	comment: string;
} {
	return {
		title: ($("#edit-page-title") as HTMLInputElement).value,
		source: ($("#edit-page-textarea") as HTMLTextAreaElement).value,
		tags: ($("#edit-page-tags") as HTMLInputElement).value
			.split(/[\s,]+/)
			.map((t) => t.trim())
			.filter(Boolean),
		comment: ($("#edit-page-comments") as HTMLTextAreaElement).value,
	};
}

function setupPageForm() {
	// action-area の data-new-type / data-edit-path でモード判定
	const area = $("#action-area");
	if (!area) return;
	const newType = isPreviewCategory(area.dataset.newType) ? area.dataset.newType : null;
	const editPath = area.dataset.editPath?.trim() || null;
	const baseRevRaw = area.dataset.baseRev;
	const isNew = newType !== null;
	const isEdit = editPath !== null;
	if (!isNew && !isEdit) return;

	$("#edit-save-button")?.addEventListener("click", async () => {
		const body = readPageFormBody();

		if (newType !== null) {
			const res = await fetch("/api/page/new", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: window.location.origin },
				body: JSON.stringify({ type: newType, ...body }),
			});
			if (res.ok) {
				const data = (await res.json()) as { path: string };
				window.location.href = `/${data.path}`;
			} else {
				const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
					error?: string;
				};
				window.alert(`Save failed: ${err.error ?? "unknown error"}`);
			}
			return;
		}
		if (editPath === null) return;

		// edit モード
		const baseRev = baseRevRaw && baseRevRaw.length > 0 ? Number(baseRevRaw) : null;
		const res = await fetch(`/api/page/${editPath}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", Origin: window.location.origin },
			body: JSON.stringify({ ...body, base_revision_number: baseRev }),
		});
		if (res.ok) {
			setHtml(area, "");
			area.removeAttribute("data-edit-path");
			area.removeAttribute("data-base-rev");
			area.style.display = "";
			// 保存後は現在の URL（ListPages の URL params を含む）で再描画する
			const reloadPath = window.location.pathname.slice(1) || (editPath as string);
			loadPage(reloadPath);
		} else {
			const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
				error?: string;
			};
			window.alert(`Save failed: ${err.error ?? "unknown error"}`);
		}
	});

	$("#edit-preview-button")?.addEventListener("click", async () => {
		const body = readPageFormBody();
		const previewBody =
			newType !== null
				? buildPreviewRequest(body.source, body.tags, { mode: "new", category: newType })
				: editPath !== null
					? buildPreviewRequest(body.source, body.tags, {
							mode: "edit",
							pagePath: editPath,
							getRenderedPagePath: () => renderedPagePath,
						})
					: null;
		if (previewBody === null) return;
		const res = await fetch("/api/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: window.location.origin },
			body: JSON.stringify(previewBody),
		});
		if (res.ok) {
			const data = (await res.json()) as { html: string; styles: string[] };
			injectStyles(data.styles);
			const pageTitle = $("#page-title");
			setHtml(pageTitle, body.title ? `<span>${escapeHtml(body.title)}</span>` : "");
			pageTitle?.toggleAttribute("hidden", !body.title);
			setHtml($("#page-content"), data.html);
			updatePageTags(body.tags);
			initRuntime();
		}
	});

	// Cancel: edit モードでは action-area を閉じてページに戻る。 new モードでは / へ。
	$("#edit-cancel-button")?.addEventListener("click", (e) => {
		if (isEdit) {
			e.preventDefault();
			setHtml(area, "");
			area.removeAttribute("data-edit-path");
			area.removeAttribute("data-base-rev");
			area.style.display = "";
			return;
		}
		// new モードは <a href="/"> のデフォルト遷移に任せる
	});
}

// --- 初期化 ---

async function init() {
	initHistory({
		injectStyles,
		initRuntime,
		loadPage,
		getRenderedPagePath: () => renderedPagePath,
	});
	setupEventHandlers();
	const initialPagePath = getPagePathFromUrl();
	renderedPagePath = initialPagePath ? normalizePagePath(initialPagePath) : null;
	authenticated = $("#login-status #btn-logout") !== null;
	setupAccountOptions();
	await Promise.all([loadSidebar(), loadTopbar()]);

	// /new SSR画面（action-area に data-new-type）が居る場合はフォーム起動して終了
	const newArea = $("#action-area");
	if (newArea?.dataset.newType) {
		setupPageForm();
		return;
	}

	initRuntime();
}

document.addEventListener("DOMContentLoaded", init);
