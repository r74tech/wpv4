import { Hono } from "hono";
import { cors } from "hono/cors";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { pages, pageTags } from "./db/schema";
import { renderWikitext, parsePagePath } from "./services/pipeline";
import { api } from "./routes/api";
import { auth } from "./routes/auth";
import { user } from "./routes/user";
import { passkeyApi } from "./routes/passkey-api";
import { renderer } from "./renderer";
import { resolveSession } from "./middleware/session";
import type { AppEnv } from "./types/env";

const app = new Hono<AppEnv>();

// セッション解決を全ルートに適用
app.use("*", resolveSession);

// CORS (API用)
app.use("/api/*", cors());

// ルート登録
app.route("/api", api);
app.route("/api/passkeys", passkeyApi);
app.route("/auth", auth);
app.route("/user", user);

// SSR: ページコンテンツをサーバーサイドでレンダリングして返す
app.use("*", renderer);
app.get("*", async (c) => {
	const rawPath = c.req.path.slice(1); // 先頭の / を除去
	const pagePath = rawPath || "main:start";
	const [category, unixName] = parsePagePath(pagePath);

	const db = drizzle(c.env.DB);
	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (!page[0]) {
		return c.render(
			<>
				<div id="page-title" />
				<div id="page-content">
					<p>Page not found.</p>
				</div>
			</>,
		);
	}

	const tags = await db
		.select({ tag: pageTags.tag })
		.from(pageTags)
		.where(eq(pageTags.pageId, page[0].id));

	const result = await renderWikitext(page[0].source, c.env, {
		pageName: unixName,
		category,
		tags: tags.map((t) => t.tag),
	});

	return c.render(
		<>
			<div id="page-title">
				<span>{page[0].title}</span>
			</div>
			<div id="page-content" dangerouslySetInnerHTML={{ __html: result.html }} />
			{result.styles.length > 0 && (
				<style dangerouslySetInnerHTML={{ __html: result.styles.join("\n") }} />
			)}
		</>,
	);
});

export default app;
