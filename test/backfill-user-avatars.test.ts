import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	d1Command,
	ownershipCommand,
	parseEnvironment,
	parseUsers,
	r2Command,
	verifyWikidotUsername,
} from "../scripts/backfill-user-avatars";

describe("avatar backfill command selection", () => {
	test("maps only explicit deployment environments to matching D1 and R2 commands", () => {
		expect(d1Command(parseEnvironment("staging"))).toContain("staging");
		expect(r2Command(parseEnvironment("staging"), "users/12/avatar", "image/png")).toContain(
			"wpv4-avatars-staging/users/12/avatar",
		);
		expect(r2Command(parseEnvironment("production"), "default/avatar", "image/jpeg")).toContain(
			"wpv4-avatars-prd/default/avatar",
		);
		const ownershipArgs = ownershipCommand(parseEnvironment("staging"), {
			wikidotId: 12,
			unixName: "user-name",
		});
		expect(ownershipArgs).toContain("staging");
		expect(ownershipArgs.join(" ")).not.toContain("user-name");
		expect(ownershipArgs.at(-1)).toContain("757365722d6e616d65");
		expect(() => parseEnvironment("local")).toThrow("staging or production");
	});

	test("parses validated Wikidot IDs from Wrangler D1 JSON", () => {
		expect(
			parseUsers(
				JSON.stringify([
					{
						results: [
							{ wikidot_id: 12, unix_name: " User-One " },
							{ wikidot_id: 34, unix_name: "user-two" },
						],
					},
				]),
			),
		).toEqual([
			{ wikidotId: 12, unixName: "user-one" },
			{ wikidotId: 34, unixName: "user-two" },
		]);
		expect(() =>
			parseUsers(JSON.stringify([{ results: [{ wikidot_id: "../../", unix_name: "user" }] }])),
		).toThrow("Invalid Wikidot user");
	});

	test("verifies current Wikidot username ownership before updating D1", async () => {
		const profile = (
			userId: number | null,
			url = "https://www.wikidot.com/user:info/user",
			prefix = "",
		) => {
			const response = new Response(
				`${prefix}${
					userId === null
						? "<script>USERINFO.other = 3661;</script>"
						: `<script>USERINFO.userId = ${userId};</script>`
				}`,
			);
			Object.defineProperty(response, "url", {
				value: url,
			});
			return response;
		};
		const fetcher = async () => profile(3661);

		expect(await verifyWikidotUsername({ wikidotId: 3661, unixName: "user" }, fetcher)).toBe(true);
		expect(
			await verifyWikidotUsername({ wikidotId: 3661, unixName: "user" }, async () =>
				profile(3661, undefined, "<p>USERINFO.userId = 34;</p>"),
			),
		).toBe(true);
		expect(await verifyWikidotUsername({ wikidotId: 34, unixName: "user" }, fetcher)).toBe(false);
		expect(
			await verifyWikidotUsername({ wikidotId: 3661, unixName: "missing" }, async () =>
				profile(-1),
			),
		).toBe(false);
		await expect(
			verifyWikidotUsername({ wikidotId: 3661, unixName: "user" }, async () =>
				profile(3661, "https://example.com/user"),
			),
		).rejects.toThrow("outside Wikidot");
		await expect(
			verifyWikidotUsername({ wikidotId: 3661, unixName: "user" }, async () => profile(null)),
		).rejects.toThrow("missing user ID");
	});

	test("leaves existing avatar ownership unverified during migration", async () => {
		const sqlite = new Database(":memory:");
		try {
			sqlite.run("CREATE TABLE users (wikidot_id INTEGER, unix_name TEXT NOT NULL)");
			sqlite.run("INSERT INTO users VALUES (12, 'possibly-stale')");
			const migration = await Bun.file(
				new URL("../db/migrations/0003_add_avatar_unix_name.sql", import.meta.url),
			).text();
			sqlite.exec(migration);
			expect(sqlite.query("SELECT avatar_unix_name FROM users").get()).toEqual({
				avatar_unix_name: null,
			});
		} finally {
			sqlite.close();
		}
	});
});
