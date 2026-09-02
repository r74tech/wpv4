import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createMiddleware } from "hono/factory";
import { pages } from "@/db/schema";
import { parseAndNormalize, routeSuffix, strictPagePath } from "@/routes/page-path";
import { recordApiAuditEvent, type ApiAuditAction } from "@/services/api-audit";
import type { AppEnv } from "@/types/env";

function mutationAction(method: string, path: string): ApiAuditAction | null {
	if (method === "POST" && path.endsWith("/pages")) return "page.create";
	if (method === "PUT" && path.includes("/pages/")) return "page.update";
	if (method === "DELETE" && path.includes("/pages/")) return "page.delete";
	if (method === "POST" && path.endsWith("/visibility")) return "page.visibility";
	return null;
}

const AUDIT_RESPONSE_FIELDS = [
	"path",
	"category",
	"unix_name",
	"revision_number",
	"deleted_at",
	"url",
	"error",
	"code",
	"current_revision_number",
	"actual_category",
	"render_error",
] as const;

export function projectAuditResponse(response: unknown): Record<string, unknown> {
	if (response === null || typeof response !== "object" || Array.isArray(response)) {
		return { error: "Non-object JSON response" };
	}
	const record = response as Record<string, unknown>;
	return Object.fromEntries(
		AUDIT_RESPONSE_FIELDS.flatMap((field) =>
			Object.hasOwn(record, field) ? [[field, record[field]]] : [],
		),
	);
}

export const auditApiMutations = createMiddleware<AppEnv>(async (c, next) => {
	const action = mutationAction(c.req.method, c.req.path);
	if (!action) return next();
	await next();
	const key = c.get("apiKey");
	const user = c.get("user");
	if (!key || !user) return;

	let response: unknown = { error: "Non-JSON response" };
	try {
		response = JSON.parse(await c.res.clone().text());
	} catch {
		// v1 responses are JSON; retain a safe marker if an unexpected handler violates that contract.
	}
	try {
		const auditResponse = projectAuditResponse(response);
		const requestedSuffix = routeSuffix(c.req.path, "/pages/");
		const requestedPath = requestedSuffix?.replace(/\/visibility$/, "") ?? "(new)";
		const pagePath = typeof auditResponse.path === "string" ? auditResponse.path : requestedPath;
		const normalizedPath = strictPagePath(pagePath);
		const pageRows = normalizedPath
			? await (() => {
					const [category, unixName] = parseAndNormalize(normalizedPath);
					return drizzle(c.env.DB)
						.select({ id: pages.id })
						.from(pages)
						.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
						.limit(1);
				})()
			: [];
		const pageId = pageRows[0]?.id ?? null;
		await recordApiAuditEvent(drizzle(c.env.DB), {
			apiKeyId: key.id,
			userId: user.id,
			action,
			pageId,
			pagePath,
			statusCode: c.res.status,
			response: auditResponse,
			now: new Date(),
		});
	} catch (error) {
		console.error("Failed to record API audit event", error);
	}
});
