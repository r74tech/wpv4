import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { pages } from "@/db/schema";
import { renderWikitext } from "@/services/pipeline";
import type { Bindings } from "@/types/env";
import type { RenderResult } from "@/services/pipeline";

export async function renderNav(
	env: Bindings,
	name: string,
	viewerId: number | null,
	existingPages?: Set<string>,
): Promise<RenderResult | null> {
	const db = drizzle(env.DB);
	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, "nav"), eq(pages.unixName, name)))
		.limit(1);

	if (!page[0]) return null;

	return renderWikitext(page[0].source, env, {
		pageName: name,
		category: "nav",
		viewerId,
		existingPages,
	});
}
