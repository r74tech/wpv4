import { initWdprRuntime } from "@wdprlib/runtime";
import type { WdprRuntime } from "@wdprlib/runtime";

// --- 型定義 ---

type PageResponse = {
	page_id: number;
	category: string;
	unix_name: string;
	title: string;
	html: string;
	styles: string[];
	revision_count: number;
	updated_at: string;
};

type UserResponse = {
	authenticated: boolean;
	user?: {
		id: number;
		wikidotId: number;
		name: string;
		unixName: string;
	};
};

// --- 状態 ---

let runtime: WdprRuntime | null = null;
let currentUser: UserResponse | null = null;

// --- DOM操作 ---

function $(selector: string): HTMLElement | null {
	return document.querySelector(selector);
}

function setHtml(el: HTMLElement | null, html: string) {
	if (el) el.innerHTML = html;
}

// --- ページ読み込み ---

async function loadPage(path: string) {
	const pageContent = $("#page-content");
	const pageTitle = $("#page-title");

	try {
		const res = await fetch(`/api/page/${path}`);
		if (!res.ok) {
			if (res.status === 404) {
				setHtml(pageContent, "<p>ページが見つかりません。</p>");
				setHtml(pageTitle, "");
				updatePageOptions(path, true);
				return;
			}
			throw new Error(`HTTP ${res.status}`);
		}

		const data: PageResponse = await res.json();
		setHtml(pageTitle, `<span>${escapeHtml(data.title)}</span>`);
		setHtml(pageContent, data.html);

		// スタイル注入
		injectStyles(data.styles);

		// WDPRランタイム初期化
		initRuntime();

		// ページオプション更新
		updatePageOptions(path, false);
	} catch (err) {
		console.error("Failed to load page:", err);
		setHtml(pageContent, "<p>ページの読み込みに失敗しました。</p>");
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

function updatePageOptions(path: string, isNew: boolean) {
	const options = $(".page-options-bottom");
	if (!options) return;

	if (!currentUser?.authenticated) {
		setHtml(options, "");
		return;
	}

	const buttons = isNew
		? `<a href="javascript:;" data-action="create" data-path="${path}">+ Create page</a>`
		: `<a href="javascript:;" data-action="edit" data-path="${path}">Edit</a>` +
		  `<a href="javascript:;" data-action="source" data-path="${path}">Source</a>` +
		  `<a href="javascript:;" data-action="history" data-path="${path}">History</a>`;

	setHtml(options, buttons);
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
		const data = await res.json() as { html: string };
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
		const data = await res.json() as { html: string };
		setHtml(topbar, data.html || "");
	} catch {
		// トップバーなしでも動作する
	}
}

// --- 認証状態 ---

async function loadAuthStatus() {
	try {
		const res = await fetch("/api/me");
		currentUser = await res.json();
		updateLoginStatus();
	} catch {
		currentUser = { authenticated: false };
	}
}

function updateLoginStatus() {
	const loginStatus = $("#login-status");
	if (!loginStatus) return;

	if (currentUser?.authenticated && currentUser.user) {
		const name = escapeHtml(currentUser.user.name);
		setHtml(
			loginStatus,
			`<span class="printuser">${name}</span>` +
			` | <a id="account-topbutton" href="javascript:;">▼</a>` +
			`<div id="account-options"><ul>` +
			`<li><a href="/user/settings">Settings</a></li>` +
			`<li><a href="/user/activities">Activities</a></li>` +
			`<li><a href="javascript:;" id="btn-logout">Sign out</a></li>` +
			`</ul></div>`,
		);

		// ▼ トグル
		const topBtn = $("#account-topbutton");
		const optionsDiv = $("#account-options");
		if (topBtn && optionsDiv) {
			optionsDiv.style.display = "none";
			topBtn.addEventListener("click", () => {
				optionsDiv.style.display = optionsDiv.style.display === "none" ? "block" : "none";
			});
		}
	} else {
		setHtml(
			loginStatus,
			`<a href="/auth/login" id="login-link">Sign in / Create account</a>`,
		);
	}
}

// --- エディタ ---

async function showEditor(path: string) {
	const actionArea = $("#action-area");
	if (!actionArea) return;

	const res = await fetch(`/api/page-source/${path}`);
	let title = "";
	let source = "";
	let tags: string[] = [];
	let revisionCount: number | null = null;

	if (res.ok) {
		const data = await res.json() as { title: string; source: string; tags: string[]; revision_count: number };
		title = data.title;
		source = data.source;
		tags = data.tags;
		revisionCount = data.revision_count;
	}

	setHtml(
		actionArea,
		`<div id="edit-page-form">
			<div class="edit-field">
				<label for="edit-title">Title</label>
				<input type="text" id="edit-title" value="${escapeAttr(title)}" />
			</div>
			<div class="edit-field">
				<label for="edit-source">Page Source</label>
				<textarea id="edit-source" rows="20">${escapeHtml(source)}</textarea>
			</div>
			<div class="edit-field">
				<label for="edit-tags">Tags (comma separated)</label>
				<input type="text" id="edit-tags" value="${escapeAttr(tags.join(", "))}" />
			</div>
			<div class="edit-field">
				<label for="edit-comment">Comment</label>
				<input type="text" id="edit-comment" value="" />
			</div>
			<div class="edit-actions">
				<button id="btn-save" data-path="${path}" data-rev="${revisionCount}">Save</button>
				<button id="btn-preview-edit">Preview</button>
				<button id="btn-cancel-edit">Cancel</button>
			</div>
			<div id="edit-preview-area"></div>
		</div>`,
	);

	// Save
	$("#btn-save")?.addEventListener("click", async () => {
		const btn = $("#btn-save") as HTMLElement;
		const p = btn.dataset.path!;
		const rev = btn.dataset.rev;
		const body = {
			title: ($("#edit-title") as HTMLInputElement).value,
			source: ($("#edit-source") as HTMLTextAreaElement).value,
			tags: ($("#edit-tags") as HTMLInputElement).value.split(",").map((t: string) => t.trim()).filter(Boolean),
			comment: ($("#edit-comment") as HTMLInputElement).value,
			base_revision_number: rev !== "null" ? Number(rev) : null,
		};

		const saveRes = await fetch(`/api/page/${p}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", Origin: window.location.origin },
			body: JSON.stringify(body),
		});

		if (saveRes.ok) {
			setHtml(actionArea, "");
			loadPage(p);
		} else {
			const err = await saveRes.json() as { error: string };
			window.alert(`Save failed: ${err.error}`);
		}
	});

	// Preview
	$("#btn-preview-edit")?.addEventListener("click", async () => {
		const src = ($("#edit-source") as HTMLTextAreaElement).value;
		const previewRes = await fetch("/api/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: window.location.origin },
			body: JSON.stringify({ source: src }),
		});
		if (previewRes.ok) {
			const data = await previewRes.json() as { html: string; styles: string[] };
			setHtml(
				$("#edit-preview-area"),
				`<h3>Preview</h3><div class="preview-content">${data.html}</div>`,
			);
		}
	});

	// Cancel
	$("#btn-cancel-edit")?.addEventListener("click", () => {
		setHtml(actionArea, "");
	});
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

	const data = await res.json() as { source: string };
	setHtml(
		actionArea,
		`<a href="javascript:;" class="action-area-close" id="btn-close-action">Close</a>` +
		`<h1>Page Source</h1>` +
		`<div class="page-source"><pre>${escapeHtml(data.source)}</pre></div>`,
	);
	$("#btn-close-action")?.addEventListener("click", () => setHtml(actionArea, ""));
}

// --- 履歴表示 ---

async function showHistory(path: string) {
	const actionArea = $("#action-area");
	if (!actionArea) return;

	const res = await fetch(`/api/page-history/${path}`);
	if (!res.ok) {
		setHtml(actionArea, "<p>Failed to load history.</p>");
		return;
	}

	type Revision = { revisionNumber: number; title: string; comment: string; createdAt: string; createdBy: number | null };
	const data = await res.json() as { revisions: Revision[] };
	const sorted = data.revisions.sort((a, b) => b.revisionNumber - a.revisionNumber);

	const rows = sorted
		.map((r) => {
			const date = r.createdAt ? new Date(r.createdAt + "Z").toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" }) : "";
			return `<tr id="revision-row-${r.revisionNumber}">` +
				`<td>${r.revisionNumber}.</td>` +
				`<td style="width: 5em" class="optionstd">` +
				`<a href="javascript:;" data-action="view-revision" data-path="${path}" data-rev="${r.revisionNumber}" title="View this version">V</a> ` +
				`<a href="javascript:;" data-action="source-revision" data-path="${path}" data-rev="${r.revisionNumber}" title="View source of this version">S</a>` +
				`</td>` +
				`<td style="padding: 0 0.5em; width: 7em;">${date}</td>` +
				`<td style="font-size: 90%">${escapeHtml(r.comment ?? "")}</td>` +
				`</tr>`;
		})
		.join("");

	setHtml(
		actionArea,
		`<a href="javascript:;" class="action-area-close" id="btn-close-action">Close</a>` +
		`<h1>Page History</h1>` +
		`<div id="revision-list">` +
		`<table class="page-history"><tbody>` +
		`<tr><td>rev.</td><td>Actions</td><td>Date</td><td>Comment</td></tr>` +
		rows +
		`</tbody></table>` +
		`</div>`,
	);
	$("#btn-close-action")?.addEventListener("click", () => setHtml(actionArea, ""));
}

// --- ユーティリティ ---

function escapeAttr(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


function escapeHtml(str: string): string {
	const div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
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

		// auth/user系はSPA遷移させず通常のナビゲーション
		if (href.startsWith("/auth/") || href.startsWith("/user/")) return;

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
		if (path) loadPage(path);
	});

	// ページオプション + ログアウト + アクション閉じる
	document.addEventListener("click", async (e) => {
		const target = e.target as HTMLElement;

		// data-action付きリンク（編集・履歴・作成・ソース）
		const actionAnchor = target.closest("[data-action]") as HTMLElement | null;
		if (actionAnchor) {
			e.preventDefault();
			const action = actionAnchor.dataset.action;
			const path = actionAnchor.dataset.path;
			if (!path) return;

			if (action === "edit" || action === "create") {
				showEditor(path);
			} else if (action === "history") {
				showHistory(path);
			} else if (action === "source") {
				showSource(path);
			}
			return;
		}

		// ログアウト
		if (target.id === "btn-logout") {
			await fetch("/auth/logout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
			});
			currentUser = { authenticated: false };
			updateLoginStatus();
			const path2 = getPagePathFromUrl();
			if (path2) loadPage(path2);
		}
	});
}

// --- 初期化 ---

async function init() {
	setupEventHandlers();
	await Promise.all([loadAuthStatus(), loadSidebar(), loadTopbar()]);

	// SSRでコンテンツが既にレンダリング済みなら、WDPRランタイム初期化とページオプション更新のみ
	const pageContent = $("#page-content");
	if (pageContent && pageContent.innerHTML.trim() && !pageContent.textContent?.includes("Loading")) {
		initRuntime();
		const path = getPagePathFromUrl();
		if (path) updatePageOptions(path, false);
	} else {
		// SSRコンテンツがない場合（フォールバック）
		const path = getPagePathFromUrl();
		if (path) await loadPage(path);
	}
}

document.addEventListener("DOMContentLoaded", init);
