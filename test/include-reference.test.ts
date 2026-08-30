import { describe, expect, test } from "bun:test";
import {
	formatIncludeSourcePath,
	parseIncludeSourcePath,
	resolveLocalIncludeUnixName,
} from "../src/lib/include-reference";

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

describe("include source path", () => {
	test("round-trips the site and page used by a cross-site include", () => {
		const path = formatIncludeSourcePath({ site: "scp-jp", page: "component:image-block" });

		expect(path).toBe(":scp-jp:component:image-block");
		expect(parseIncludeSourcePath(path)).toEqual({
			site: "scp-jp",
			page: "component:image-block",
		});
	});
});
