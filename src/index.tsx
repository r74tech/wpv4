import { Hono } from "hono";
import { raw } from "hono/utils/html";
import { cors } from "hono/cors";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, isNull } from "drizzle-orm";
import { pages, pageTags } from "./db/schema";
import { renderWikitext, parsePagePath, formatPagePath } from "./services/pipeline";
import { renderNav } from "./services/nav";
import { api } from "./routes/api";
import { auth } from "./routes/auth";
import { user } from "./routes/user";
import { WikidotShell } from "./components/WikidotShell";
import { PageTitle } from "./components/PageTitle";
import { resolveSession } from "./middleware/session";
import {
	canEditPage,
	canManagePage,
	canViewPage,
	getVisibility,
	isUlidCategory,
	normalizeUlid,
} from "./lib/visibility";
import type { AppEnv } from "./types/env";

const app = new Hono<AppEnv>();

app.use("*", resolveSession);
app.use("/api/*", cors());

app.route("/api", api);
app.route("/auth", auth);
app.route("/user", user);

function PageTags({ tags }: { tags: string[] }) {
	if (tags.length === 0) return null;
	return (
		<div class="page-tags">
			<span>
				{tags.map((tag) => (
					<a href={`/system:page-tags/tag/${encodeURIComponent(tag)}#pages`}>{tag}</a>
				))}
			</span>
		</div>
	);
}

// /new: 新規ページ作成画面（app.get("*") より前に登録）
app.get("/new", async (c) => {
	const type = c.req.query("type");
	if (type !== "public" && type !== "share" && type !== "private") {
		return c.text("Invalid type. Expected 'public', 'share' or 'private'.", 400);
	}
	const viewer = c.get("user");
	if (!viewer) {
		return c.redirect("/auth/login", 302);
	}

	const [sidebar, topbar] = await Promise.all([
		renderNav(c.env, "side", viewer.id),
		renderNav(c.env, "top", viewer.id),
	]);

	// Wikidot のページ編集画面構造を踏襲（既存CSSを活かすため）
	return c.html(
		<WikidotShell sidebar={sidebar} topbar={topbar} user={viewer} filesDomain={c.env.FILES_DOMAIN}>
			<PageTitle title="" />
			<div id="page-content" />
			<div id="action-area" style="display: block;" data-new-type={type}>
				<h1>Create a new {type} page</h1>
				<div>
					<form id="edit-page-form" onsubmit="return false;">
						<table class="form" style="margin: 0.5em auto 1em 0">
							<tbody>
								<tr>
									<td>Title of the page:</td>
									<td>
										<input
											class="text"
											id="edit-page-title"
											name="title"
											type="text"
											value=""
											size={35}
											maxlength={128}
											style="font-weight: bold; font-size: 130%;"
										/>
									</td>
								</tr>
							</tbody>
						</table>
						<div>
							<textarea
								id="edit-page-textarea"
								name="source"
								rows={20}
								cols={60}
								style="width: 95%;"
							/>
						</div>
						<div class="edit-help-34">
							Help:{" "}
							<a href="http://www.wikidot.com/doc:quick-reference" target="_blank" rel="noopener">
								wiki text quick reference
							</a>
						</div>
						<table class="edit-page-bottomtable" style="padding: 2px 0; border: none;">
							<tbody>
								<tr>
									<td style="border: none; padding: 0 5px;">
										<div>
											Tags (space separated):
											<br />
											<input type="text" id="edit-page-tags" name="tags" value="" />
										</div>
										<div style="margin-top: 0.5em;">
											Short description of changes:
											<br />
											<textarea id="edit-page-comments" name="comments" rows={2} cols={40} />
										</div>
									</td>
								</tr>
							</tbody>
						</table>
						<div class="buttons alignleft">
							<a href="/" class="btn btn-danger" id="edit-cancel-button">
								Cancel
							</a>
							<input
								type="button"
								id="edit-preview-button"
								class="btn btn-default"
								value="Preview"
							/>
							<input
								type="button"
								id="edit-save-button"
								class="btn btn-primary"
								value="Save"
								data-type={type}
							/>
						</div>
					</form>
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
	const unixName = isUlidCategory(category) ? normalizeUlid(unixNameRaw) : unixNameRaw;

	const viewer = c.get("user");
	const viewerId = viewer?.id ?? null;
	const db = drizzle(c.env.DB);

	const [pageRow, sidebar, topbar] = await Promise.all([
		db
			.select()
			.from(pages)
			.where(
				and(eq(pages.category, category), eq(pages.unixName, unixName), isNull(pages.deletedAt)),
			)
			.limit(1),
		renderNav(c.env, "side", viewerId),
		renderNav(c.env, "top", viewerId),
	]);

	const page = pageRow[0];

	if (!page) {
		return c.html(
			<WikidotShell
				sidebar={sidebar}
				topbar={topbar}
				user={viewer}
				filesDomain={c.env.FILES_DOMAIN}
			>
				<PageTitle title="" />
				<div id="page-content">
					<p>Page not found.</p>
				</div>
			</WikidotShell>,
			404,
		);
	}

	if (!canViewPage(page, viewerId)) {
		return c.html(
			<WikidotShell
				sidebar={sidebar}
				topbar={topbar}
				user={viewer}
				filesDomain={c.env.FILES_DOMAIN}
			>
				<PageTitle title="Forbidden" />
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
	const tagNames = tags.map((t) => t.tag);

	const result = await renderWikitext(page.source, c.env, {
		pageName: unixName,
		category,
		tags: tagNames,
		viewerId,
		urlPath: c.req.path,
		persistHtmlBlocks: true,
	});

	return c.html(
		<WikidotShell
			sidebar={sidebar}
			topbar={topbar}
			pageStyles={result.styles}
			title={page.title}
			user={viewer}
			filesDomain={c.env.FILES_DOMAIN}
			pageActions={{
				path: formatPagePath(category, unixName),
				page: {
					category,
					unix_name: unixName,
					visibility: getVisibility(page.category, page.unixName),
					can_edit: canEditPage(page, viewerId),
					can_manage: canManagePage(page, viewerId),
				},
			}}
		>
			<PageTitle title={page.title} />
			<div id="page-content">{raw(result.html)}</div>
			<PageTags tags={tagNames} />
		</WikidotShell>,
	);
});

export default app;
