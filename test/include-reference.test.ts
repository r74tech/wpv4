import { describe, expect, test } from "bun:test";
import { resolveLocalIncludeUnixName } from "../src/lib/include-reference";

describe("resolveLocalIncludeUnixName", () => {
	test("accepts local page names regardless of site or category separator", () => {
		const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

		expect(resolveLocalIncludeUnixName({ site: null, page: `public:${ulid}` })).toBe(
			ulid.toLowerCase(),
		);
		expect(resolveLocalIncludeUnixName({ site: null, page: `public;${ulid}` })).toBe(
			ulid.toLowerCase(),
		);
		expect(resolveLocalIncludeUnixName({ site: "scp-jp", page: `public:${ulid}` })).toBe(
			ulid.toLowerCase(),
		);
	});
});
