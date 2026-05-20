import { Hono } from "hono";
import { raw } from "hono/utils/html";
import { cors } from "hono/cors";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { pages, pageTags } from "./db/schema";
import { renderWikitext, parsePagePath, getExistingPageSet } from "./services/pipeline";
import { renderNav } from "./services/nav";
import { api } from "./routes/api";
import { auth } from "./routes/auth";
import { user } from "./routes/user";
import { passkeyApi } from "./routes/passkey-api";
import { WikidotShell } from "./components/WikidotShell";
import { resolveSession } from "./middleware/session";
import { canViewPage, isShare, isPrivate, normalizeUlid } from "./lib/visibility";
import type { AppEnv } from "./types/env";

const app = new Hono<AppEnv>();

app.use("*", resolveSession);
app.use("/api/*", cors());

app.route("/api", api);
app.route("/api/passkeys", passkeyApi);
app.route("/auth", auth);
app.route("/user", user);

// /new: 新規ページ作成画面（app.get("*") より前に登録）
app.get("/new", async (c) => {
	const type = c.req.query("type");
	if (type !== "share" && type !== "private") {
		return c.text("Invalid type. Expected 'share' or 'private'.", 400);
	}
	const viewer = c.get("user");
	if (!viewer) {
		return c.redirect("/auth/login", 302);
	}

	const [sidebar, topbar] = await Promise.all([
		renderNav(c.env, "side", viewer.id),
		renderNav(c.env, "top", viewer.id),
	]);

	return c.html(
		<WikidotShell sidebar={sidebar} topbar={topbar}>
			<div id="page-title">
				<span>New {type} page</span>
			</div>
			<div id="page-content">
				<div id="new-page-form" data-new-type={type}>
					<div class="edit-field">
						<label for="new-title">Title</label>
						<input type="text" id="new-title" value="" />
					</div>
					<div class="edit-field">
						<label for="new-source">Page Source</label>
						<textarea id="new-source" rows={20} />
					</div>
					<div class="edit-field">
						<label for="new-tags">Tags (comma separated)</label>
						<input type="text" id="new-tags" value="" />
					</div>
					<div class="edit-field">
						<label for="new-comment">Comment</label>
						<input type="text" id="new-comment" value="" />
					</div>
					<div class="edit-actions">
						<button id="btn-new-save" data-type={type}>
							Save
						</button>
						<button id="btn-new-preview">Preview</button>
						<a href="/">Cancel</a>
					</div>
					<div id="new-preview-area" />
				</div>
			</div>
		</WikidotShell>,
	);
});

app.get("*", async (c) => {
	const rawPath = c.req.path.slice(1);
	const pagePath = rawPath || "main";
	const [category, unixNameRaw] = parsePagePath(pagePath);
	// share/private の unix_name は小文字統一（WDPR renderer の toLowerCase() と整合）
	const unixName =
		isShare(category) || isPrivate(category) ? normalizeUlid(unixNameRaw) : unixNameRaw;

	const viewerId = c.get("user")?.id ?? null;
	const db = drizzle(c.env.DB);

	// ページ存在Setとページデータを並列取得
	const [existingPages, pageRow] = await Promise.all([
		getExistingPageSet(c.env.DB, viewerId),
		db
			.select()
			.from(pages)
			.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
			.limit(1),
	]);

	// sidebar・topbar をSet付きで並列レンダリング
	const [sidebar, topbar] = await Promise.all([
		renderNav(c.env, "side", viewerId, existingPages),
		renderNav(c.env, "top", viewerId, existingPages),
	]);

	const page = pageRow[0];

	if (!page) {
		return c.html(
			<WikidotShell sidebar={sidebar} topbar={topbar}>
				<div id="page-title" />
				<div id="page-content">
					<p>Page not found.</p>
				</div>
			</WikidotShell>,
			404,
		);
	}

	if (!canViewPage(page, viewerId)) {
		return c.html(
			<WikidotShell sidebar={sidebar} topbar={topbar}>
				<div id="page-title">
					<span>Forbidden</span>
				</div>
				<div id="page-content">
					<p>This page is private.</p>
				</div>
			</WikidotShell>,
			403,
		);
	}

	const tags = await db
		.select({ tag: pageTags.tag })
		.from(pageTags)
		.where(eq(pageTags.pageId, page.id));

	const result = await renderWikitext(page.source, c.env, {
		pageName: unixName,
		category,
		tags: tags.map((t) => t.tag),
		viewerId,
		existingPages,
	});

	return c.html(
		<WikidotShell sidebar={sidebar} topbar={topbar} pageStyles={result.styles}>
			<div id="page-title">
				<span>{page.title}</span>
			</div>
			<div id="page-content">{raw(result.html)}</div>
		</WikidotShell>,
	);
});

export default app;
