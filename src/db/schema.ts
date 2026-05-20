import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

const now = sql`(datetime('now'))`;

export const users = sqliteTable("users", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	wikidotId: integer("wikidot_id").unique().notNull(),
	name: text("name").notNull(),
	unixName: text("unix_name").notNull(),
	createdAt: text("created_at").default(now),
	lastLoginAt: text("last_login_at"),
});

export const sessions = sqliteTable(
	"sessions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		tokenHash: text("token_hash").unique().notNull(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at").default(now),
	},
	(table) => [
		index("idx_sessions_token_hash").on(table.tokenHash),
		index("idx_sessions_expires_at").on(table.expiresAt),
	],
);

export const pages = sqliteTable(
	"pages",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		category: text("category").notNull(),
		unixName: text("unix_name").notNull().unique(),
		title: text("title").notNull().default(""),
		source: text("source").notNull().default(""),
		revisionCount: integer("revision_count").default(0),
		isLocked: integer("is_locked").notNull().default(0),
		createdBy: integer("created_by").references(() => users.id),
		updatedBy: integer("updated_by").references(() => users.id),
		createdAt: text("created_at").default(now),
		updatedAt: text("updated_at").default(now),
	},
	(table) => [index("idx_pages_category").on(table.category)],
);

export const revisions = sqliteTable(
	"revisions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		pageId: integer("page_id")
			.notNull()
			.references(() => pages.id, { onDelete: "cascade" }),
		revisionNumber: integer("revision_number").notNull(),
		title: text("title").notNull().default(""),
		source: text("source").notNull().default(""),
		comment: text("comment").default(""),
		createdBy: integer("created_by").references(() => users.id),
		createdAt: text("created_at").default(now),
	},
	(table) => [
		uniqueIndex("idx_revisions_page_rev").on(table.pageId, table.revisionNumber),
		index("idx_revisions_page_id").on(table.pageId),
	],
);

export const pageTags = sqliteTable(
	"page_tags",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		pageId: integer("page_id")
			.notNull()
			.references(() => pages.id, { onDelete: "cascade" }),
		tag: text("tag").notNull(),
	},
	(table) => [
		uniqueIndex("idx_page_tags_unique").on(table.pageId, table.tag),
		index("idx_page_tags_page_id").on(table.pageId),
		index("idx_page_tags_tag").on(table.tag),
	],
);

export const passkeys = sqliteTable(
	"passkeys",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		credentialId: text("credential_id").unique().notNull(),
		publicKey: text("public_key").notNull(),
		counter: integer("counter").notNull().default(0),
		deviceType: text("device_type"),
		backedUp: integer("backed_up").notNull().default(0),
		transports: text("transports"),
		name: text("name").notNull().default(""),
		createdAt: text("created_at").default(now),
	},
	(table) => [
		index("idx_passkeys_user_id").on(table.userId),
		uniqueIndex("idx_passkeys_credential_id").on(table.credentialId),
	],
);

export const votes = sqliteTable(
	"votes",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		pageId: integer("page_id")
			.notNull()
			.references(() => pages.id, { onDelete: "cascade" }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id),
		value: integer("value").notNull(),
		createdAt: text("created_at").default(now),
	},
	(table) => [uniqueIndex("idx_votes_unique").on(table.pageId, table.userId)],
);
