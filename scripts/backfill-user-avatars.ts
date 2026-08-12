import {
	AVATAR_CACHE_CONTROL,
	DEFAULT_AVATAR_KEY,
	avatarKey,
	downloadWikidotAvatar,
	readLimitedResponseBody,
} from "../src/services/avatar";

type EnvironmentName = "staging" | "production";

const MAX_PROFILE_BYTES = 256 * 1024;
const PROFILE_FETCH_TIMEOUT_MS = 3000;

export type BackfillEnvironment = {
	name: EnvironmentName;
	bucket: string;
};

const environments: Record<EnvironmentName, BackfillEnvironment> = {
	staging: { name: "staging", bucket: "wpv4-avatars-staging" },
	production: { name: "production", bucket: "wpv4-avatars-prd" },
};

type BunProcess = {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
};

type BunRuntime = {
	argv: string[];
	spawn(args: string[], options: Record<string, unknown>): BunProcess;
};

const runtime = (globalThis as typeof globalThis & { Bun: BunRuntime }).Bun;

export function parseEnvironment(value: string | undefined): BackfillEnvironment {
	if (value !== "staging" && value !== "production") {
		throw new Error("Environment must be staging or production");
	}
	return environments[value];
}

export function d1Command(environment: BackfillEnvironment): string[] {
	return [
		"bunx",
		"wrangler",
		"d1",
		"execute",
		"DB",
		"--env",
		environment.name,
		"--remote",
		"--command",
		"SELECT wikidot_id, unix_name FROM users ORDER BY wikidot_id",
		"--json",
	];
}

export function r2Command(
	environment: BackfillEnvironment,
	key: string,
	contentType: string,
): string[] {
	return [
		"bunx",
		"wrangler",
		"r2",
		"object",
		"put",
		`${environment.bucket}/${key}`,
		"--env",
		environment.name,
		"--remote",
		"--force",
		"--pipe",
		"--content-type",
		contentType,
		"--cache-control",
		AVATAR_CACHE_CONTROL,
	];
}

export function ownershipCommand(environment: BackfillEnvironment, user: BackfillUser): string[] {
	const encodedName = Array.from(new TextEncoder().encode(user.unixName), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return [
		"bunx",
		"wrangler",
		"d1",
		"execute",
		"DB",
		"--env",
		environment.name,
		"--remote",
		"--command",
		`UPDATE users SET avatar_unix_name = CAST(X'${encodedName}' AS TEXT) WHERE wikidot_id = ${user.wikidotId} AND avatar_unix_name IS NULL AND lower(trim(unix_name)) = CAST(X'${encodedName}' AS TEXT)`,
	];
}

export type BackfillUser = { wikidotId: number; unixName: string };

export function parseUsers(json: string): BackfillUser[] {
	const value: unknown = JSON.parse(json);
	if (!Array.isArray(value)) throw new Error("Invalid Wrangler D1 output");

	const users: BackfillUser[] = [];
	for (const result of value) {
		if (!isRecord(result) || !Array.isArray(result.results)) {
			throw new Error("Invalid Wrangler D1 output");
		}
		for (const row of result.results) {
			const id = isRecord(row) ? row.wikidot_id : undefined;
			const rawUnixName = isRecord(row) ? row.unix_name : undefined;
			if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
				throw new Error("Invalid Wikidot user in Wrangler D1 output");
			}
			const unixName =
				typeof rawUnixName === "string" ? rawUnixName.trim().toLowerCase().toWellFormed() : "";
			if (!unixName || unixName.length > 128) {
				throw new Error("Invalid Wikidot username in Wrangler D1 output");
			}
			users.push({ wikidotId: id, unixName });
		}
	}
	return users;
}

export async function verifyWikidotUsername(
	user: BackfillUser,
	fetcher: typeof fetch = fetch,
): Promise<boolean> {
	const response = await fetcher(
		`https://www.wikidot.com/user:info/${encodeURIComponent(user.unixName)}`,
		{
			redirect: "follow",
			signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
		},
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Wikidot profile request failed with status ${response.status}`);
	}
	const profileUrl = new URL(response.url);
	if (profileUrl.protocol !== "https:") {
		await response.body?.cancel();
		throw new Error("Wikidot profile redirected outside HTTPS");
	}
	if (profileUrl.hostname !== "www.wikidot.com") {
		await response.body?.cancel();
		throw new Error("Wikidot profile redirected outside Wikidot");
	}
	const contentLength = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_PROFILE_BYTES) {
		await response.body?.cancel();
		throw new Error("Wikidot profile is too large");
	}

	const html = new TextDecoder().decode(
		await readLimitedResponseBody(response, MAX_PROFILE_BYTES, "Wikidot profile"),
	);
	let profileId: string | undefined;
	for (const match of html.matchAll(/\bUSERINFO\.userId\s*=\s*(-?\d+)\s*;/g)) {
		profileId = match[1];
	}
	if (profileId === undefined) throw new Error("Wikidot profile is missing user ID");
	return Number(profileId) === user.wikidotId;
}

async function main(): Promise<void> {
	const environment = parseEnvironment(runtime.argv[2]);
	const users = parseUsers(await runCommand(d1Command(environment)));
	const defaultAvatar = await downloadWikidotAvatar(2);
	await runCommand(
		r2Command(environment, DEFAULT_AVATAR_KEY, defaultAvatar.contentType),
		defaultAvatar.bytes,
	);

	const failures: string[] = [];
	// ponytail: sequential uploads keep recovery obvious; add bounded concurrency if runtime is measured as a problem.
	for (const user of users) {
		try {
			const downloaded = await downloadWikidotAvatar(user.wikidotId);
			await runCommand(
				r2Command(environment, avatarKey(user.wikidotId), downloaded.contentType),
				downloaded.bytes,
			);
			if (await verifyWikidotUsername(user)) {
				await runCommand(ownershipCommand(environment, user));
			} else {
				console.warn(`skipped stale username ${user.unixName} for ${user.wikidotId}`);
			}
			console.log(`stored ${user.wikidotId}`);
		} catch (error) {
			failures.push(`${user.wikidotId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (failures.length > 0) {
		throw new Error(`Avatar backfill failed for ${failures.length} users:\n${failures.join("\n")}`);
	}
	console.log(`stored default and ${users.length} user avatars in ${environment.bucket}`);
}

async function runCommand(args: string[], stdin?: Uint8Array): Promise<string> {
	const process = runtime.spawn(args, { stdin, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
	}
	return stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) await main();
