import { drizzle } from "drizzle-orm/d1";
import { apiAuditEvents } from "@/db/schema";

type Db = ReturnType<typeof drizzle>;

export type ApiAuditAction = "page.create" | "page.update" | "page.delete" | "page.visibility";

export async function recordApiAuditEvent(
	db: Db,
	event: {
		apiKeyId: number;
		userId: number;
		action: ApiAuditAction;
		pageId: number | null;
		pagePath: string;
		statusCode: number;
		response: unknown;
		now: Date;
	},
): Promise<void> {
	await db.insert(apiAuditEvents).values({
		apiKeyId: event.apiKeyId,
		userId: event.userId,
		action: event.action,
		pageId: event.pageId,
		pagePath: event.pagePath,
		statusCode: event.statusCode,
		responseJson: JSON.stringify(event.response),
		createdAt: event.now.toISOString(),
	});
}
