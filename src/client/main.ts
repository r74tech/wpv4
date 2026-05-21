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
	visibility: "public" | "share" | "private";
	viewer_is_owner: boolean;
	can_edit: boolean;
	can_manage: boolean;
	created_by: number | null;
	is_locked: boolean;
};

type ReferencedBy = {
	category: string;
	unix_name: string;
	title: string;
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
			} else if (res.status === 403) {
				setHtml(pageContent, "<p>This page is private.</p>");
				setHtml(pageTitle, "<span>Forbidden</span>");
			} else {
				throw new Error(`HTTP ${res.status}`);
			}
			clearPageOptions();
			return;
		}

		const data: PageResponse = await res.json();
		setHtml(pageTitle, `<span>${escapeHtml(data.title)}</span>`);
		setHtml(pageContent, data.html);

		injectStyles(data.styles);
		initRuntime();
		updatePageOptions(path, data);
	} catch (err) {
		console.error("Failed to load page:", err);
		setHtml(pageContent, "<p>ページの読み込みに失敗しました。</p>");
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

	if (!currentUser?.authenticated) {
		setHtml(options, "");
		return;
	}

	// サーバー判定済みフラグに従ってボタンを出す
	const parts: string[] = [];
	if (page.can_edit) {
		parts.push(`<a href="javascript:;" data-action="edit" data-path="${path}">Edit</a>`);
	}
	parts.push(`<a href="javascript:;" data-action="source" data-path="${path}">Source</a>`);
	parts.push(`<a href="javascript:;" data-action="history" data-path="${path}">History</a>`);

	// 作成者には現状以外の2つへの Toggle ボタンを出す
	if (page.can_manage) {
		const all: Array<"public" | "share" | "private"> = ["public", "share", "private"];
		for (const target of all) {
			if (target === page.visibility) continue;
			parts.push(
				`<a href="javascript:;" data-action="toggle-visibility" data-ulid="${page.unix_name}" data-target="${target}">Make ${target}</a>`,
			);
		}
	}

	setHtml(options, parts.join(""));
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
		setHtml(loginStatus, `<a href="/auth/login" id="login-link">Sign in / Create account</a>`);
	}
	updateSidebarActions();
}

function updateSidebarActions() {
	const actions = $("#side-bar-actions");
	if (!actions) return;
	if (currentUser?.authenticated) {
		setHtml(
			actions,
			`<p>` +
				`<a href="/new?type=public">+ New public page</a><br />` +
				`<a href="/new?type=share">+ New share page</a><br />` +
				`<a href="/new?type=private">+ New private page</a>` +
				`</p>`,
		);
	} else {
		setHtml(actions, "");
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
			tags: ($("#edit-tags") as HTMLInputElement).value
				.split(",")
				.map((t: string) => t.trim())
				.filter(Boolean),
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
			const err = (await saveRes.json()) as { error: string };
			window.alert(`Save failed: ${err.error}`);
		}
	});

	// Preview: 結果を #page-title / #page-content に直接反映する
	$("#btn-preview-edit")?.addEventListener("click", async () => {
		const src = ($("#edit-source") as HTMLTextAreaElement).value;
		const title = ($("#edit-title") as HTMLInputElement).value;
		const previewRes = await fetch("/api/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: window.location.origin },
			body: JSON.stringify({ source: src }),
		});
		if (previewRes.ok) {
			const data = (await previewRes.json()) as { html: string; styles: string[] };
			injectStyles(data.styles);
			setHtml($("#page-title"), title ? `<span>${escapeHtml(title)}</span>` : "");
			setHtml($("#page-content"), data.html);
			initRuntime();
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

	const data = (await res.json()) as { source: string };
	setHtml(
		actionArea,
		`<a href="javascript:;" class="action-area-close" id="btn-close-action">Close</a>` +
			`<h1>Page Source</h1>` +
			`<div class="page-source"><pre>${escapeHtml(data.source)}</pre></div>`,
	);
	$("#btn-close-action")?.addEventListener("click", () => setHtml(actionArea, ""));
}

// --- 特定リビジョン表示 ---

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
};

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

async function showRevisionView(path: string, num: number) {
	const data = await fetchRevision(path, num);
	if (!data) {
		openHistorySubarea("<p>Failed to load revision.</p>");
		return;
	}

	const previewRes = await fetch("/api/preview", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: window.location.origin },
		body: JSON.stringify({ source: data.source }),
	});
	const rendered = previewRes.ok
		? ((await previewRes.json()) as { html: string; styles: string[] })
		: { html: `<pre>${escapeHtml(data.source)}</pre>`, styles: [] };

	// Wikidot: View Revision は #page-content を上書き、上に #page-version-info メタを表示
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

	injectStyles(rendered.styles);
	setHtml($("#page-title"), `<span>${escapeHtml(data.title)}</span>`);
	setHtml($("#page-content"), versionInfo + rendered.html);
	initRuntime();
	$("#btn-close-version-info")?.addEventListener("click", () => {
		const info = document.getElementById("page-version-info");
		if (info) info.style.display = "none";
	});
}

async function showRevisionSource(path: string, num: number) {
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

// --- 履歴表示 ---

async function showHistory(path: string) {
	const actionArea = $("#action-area");
	if (!actionArea) return;

	const res = await fetch(`/api/page-history/${path}`);
	if (!res.ok) {
		setHtml(actionArea, "<p>Failed to load history.</p>");
		return;
	}

	type Revision = {
		revisionNumber: number;
		title: string;
		comment: string;
		createdAt: string;
		createdBy: number | null;
	};
	const data = (await res.json()) as { revisions: Revision[] };
	const sorted = data.revisions.sort((a, b) => b.revisionNumber - a.revisionNumber);

	const rows = sorted
		.map((r) => {
			const date = r.createdAt
				? new Date(r.createdAt + "Z").toLocaleDateString("ja-JP", {
						year: "numeric",
						month: "short",
						day: "numeric",
					})
				: "";
			return (
				`<tr id="revision-row-${r.revisionNumber}">` +
				`<td>${r.revisionNumber}.</td>` +
				`<td style="width: 5em">&nbsp;</td>` +
				`<td>&nbsp;</td>` +
				`<td style="width: 5em" class="optionstd">` +
				`<a title="" href="javascript:;" data-action="view-revision" data-path="${path}" data-rev="${r.revisionNumber}">V</a> ` +
				`<a title="" href="javascript:;" data-action="source-revision" data-path="${path}" data-rev="${r.revisionNumber}">S</a>` +
				`</td>` +
				`<td style="width: 15em">${r.createdBy ?? ""}</td>` +
				`<td style="padding: 0 0.5em; width: 7em;">${date}</td>` +
				`<td style="font-size: 90%">${escapeHtml(r.comment ?? "")}</td>` +
				`</tr>`
			);
		})
		.join("");

	setHtml(
		actionArea,
		`<a href="javascript:;" class="action-area-close btn btn-danger" id="btn-close-action">` +
			`<i class="icon-remove"></i> Close</a>` +
			`<h1>Page history of changes</h1>` +
			`<div id="revision-list">` +
			`<table class="page-history"><tbody>` +
			`<tr><td>rev.</td><td>&nbsp;</td><td>flags</td><td>actions</td><td>by</td><td>date</td><td>comments</td></tr>` +
			rows +
			`</tbody></table>` +
			`</div>` +
			`<div id="history-subarea" style="display: none;"></div>`,
	);
	$("#btn-close-action")?.addEventListener("click", () => setHtml(actionArea, ""));
}

// --- ユーティリティ ---

function escapeAttr(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
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
		if (path) loadPage(path);
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
				if (
					ulid &&
					(toggleTarget === "public" || toggleTarget === "share" || toggleTarget === "private")
				) {
					await toggleVisibility(ulid, toggleTarget, false);
				}
				return;
			}

			const path = actionAnchor.dataset.path;
			if (!path) return;

			if (action === "edit") {
				showEditor(path);
			} else if (action === "history") {
				showHistory(path);
			} else if (action === "source") {
				showSource(path);
			} else if (action === "view-revision") {
				const rev = Number(actionAnchor.dataset.rev);
				if (!Number.isNaN(rev)) showRevisionView(path, rev);
			} else if (action === "source-revision") {
				const rev = Number(actionAnchor.dataset.rev);
				if (!Number.isNaN(rev)) showRevisionSource(path, rev);
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

// --- visibility トグル ---

async function toggleVisibility(
	ulid: string,
	target: "public" | "share" | "private",
	force: boolean,
): Promise<void> {
	const res = await fetch(`/api/page/${ulid}/visibility`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: window.location.origin },
		body: JSON.stringify({ target, force }),
	});

	if (res.ok) {
		const data = (await res.json()) as { new_path: string };
		// 新URL（prefixが変わる）へフルロード遷移
		window.location.href = `/${data.new_path}`;
		return;
	}

	if (res.status === 409) {
		const data = (await res.json()) as {
			referenced_by: ReferencedBy[];
			hidden_referenced_count: number;
			include_becomes_broken?: boolean;
			list_pages_presence_changes?: boolean;
		};
		showReferenceWarning(ulid, target, data.referenced_by, data.hidden_referenced_count, {
			includeBecomesBroken: data.include_becomes_broken ?? false,
			listPagesPresenceChanges: data.list_pages_presence_changes ?? false,
		});
		return;
	}

	const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
		error?: string;
	};
	window.alert(`Toggle failed: ${err.error ?? "unknown error"}`);
}

function showReferenceWarning(
	ulid: string,
	target: "public" | "share" | "private",
	visible: ReferencedBy[],
	hiddenCount: number,
	impact: { includeBecomesBroken: boolean; listPagesPresenceChanges: boolean },
): void {
	// 既存モーダルがあれば消す
	$("#visibility-confirm-modal")?.remove();

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
		`<button id="btn-toggle-cancel">Cancel</button>` +
		`<button id="btn-toggle-force">Force ${escapeHtml(target)}</button>` +
		`</div></div>`;
	document.body.appendChild(modal);

	$("#btn-toggle-cancel")?.addEventListener("click", () => modal.remove());
	$("#btn-toggle-force")?.addEventListener("click", async () => {
		modal.remove();
		await toggleVisibility(ulid, target, true);
	});
}

// --- 新規ページ作成フォーム（/new SSR） ---

function setupNewPageForm() {
	// /new SSR では action-area に data-new-type が付く（Wikidot互換構造）
	const area = $("#action-area");
	const type = area?.dataset.newType;
	if (type !== "public" && type !== "share" && type !== "private") return;

	$("#edit-save-button")?.addEventListener("click", async () => {
		const body = {
			type,
			title: ($("#edit-page-title") as HTMLInputElement).value,
			source: ($("#edit-page-textarea") as HTMLTextAreaElement).value,
			tags: ($("#edit-page-tags") as HTMLInputElement).value
				.split(",")
				.map((t: string) => t.trim())
				.filter(Boolean),
			comment: ($("#edit-page-comments") as HTMLTextAreaElement).value,
		};

		const res = await fetch("/api/page/new", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: window.location.origin },
			body: JSON.stringify(body),
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
	});

	$("#edit-preview-button")?.addEventListener("click", async () => {
		const src = ($("#edit-page-textarea") as HTMLTextAreaElement).value;
		const title = ($("#edit-page-title") as HTMLInputElement).value;
		const res = await fetch("/api/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: window.location.origin },
			body: JSON.stringify({ source: src }),
		});
		if (res.ok) {
			const data = (await res.json()) as { html: string; styles: string[] };
			injectStyles(data.styles);
			setHtml($("#page-title"), title ? `<span>${escapeHtml(title)}</span>` : "");
			setHtml($("#page-content"), data.html);
			initRuntime();
		}
	});
}

// --- 初期化 ---

async function init() {
	setupEventHandlers();
	await Promise.all([loadAuthStatus(), loadSidebar(), loadTopbar()]);

	// /new SSR画面（action-area に data-new-type）が居る場合はフォーム起動して終了
	const newArea = $("#action-area");
	if (newArea?.dataset.newType) {
		setupNewPageForm();
		return;
	}

	// SSRでコンテンツが既にレンダリング済みなら、WDPRランタイムを初期化し
	// /api/page/* を1回叩いて can_edit / visibility 等のフラグを取得（updatePageOptions に渡す）
	const pageContent = $("#page-content");
	if (
		pageContent &&
		pageContent.innerHTML.trim() &&
		!pageContent.textContent?.includes("Loading")
	) {
		initRuntime();
		const path = getPagePathFromUrl();
		if (path) {
			try {
				const res = await fetch(`/api/page/${path}`);
				if (res.ok) {
					const data: PageResponse = await res.json();
					updatePageOptions(path, data);
				} else {
					clearPageOptions();
				}
			} catch {
				clearPageOptions();
			}
		}
	} else {
		// SSRコンテンツがない場合（フォールバック）
		const path = getPagePathFromUrl();
		if (path) await loadPage(path);
	}
}

document.addEventListener("DOMContentLoaded", init);
