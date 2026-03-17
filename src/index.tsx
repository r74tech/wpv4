import { Hono } from "hono";
import { raw } from "hono/utils/html";
import { cors } from "hono/cors";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { pages, pageTags } from "./db/schema";
import { renderWikitext, parsePagePath } from "./services/pipeline";
import { renderNav } from "./services/nav";
import { api } from "./routes/api";
import { auth } from "./routes/auth";
import { user } from "./routes/user";
import { passkeyApi } from "./routes/passkey-api";
import { WikidotShell } from "./components/WikidotShell";
import { resolveSession } from "./middleware/session";
import type { AppEnv } from "./types/env";

const app = new Hono<AppEnv>();

app.use("*", resolveSession);
app.use("/api/*", cors());

app.route("/api", api);
app.route("/api/passkeys", passkeyApi);
app.route("/auth", auth);
app.route("/user", user);

app.get("*", async (c) => {
	const rawPath = c.req.path.slice(1);
	const pagePath = rawPath || "main:start";
	const [category, unixName] = parsePagePath(pagePath);

	const db = drizzle(c.env.DB);

	// ページ・sidebar・topbar を並列取得
	const [pageRow, sidebar, topbar] = await Promise.all([
		db.select().from(pages).where(and(eq(pages.category, category), eq(pages.unixName, unixName))).limit(1),
		renderNav(c.env, "side"),
		renderNav(c.env, "top"),
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
