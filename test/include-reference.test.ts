import { describe, expect, test } from "bun:test";
import {
	formatIncludeSourcePath,
	parseIncludeSourcePath,
	resolveLocalIncludeTarget,
} from "../src/lib/include-reference";

describe("resolveLocalIncludeTarget", () => {
	test("accepts local page names regardless of site or category separator", () => {
		const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

		expect(resolveLocalIncludeTarget({ site: null, page: `public:${ulid}` })).toEqual({
			category: null,
			unixName: ulid.toLowerCase(),
		});
		expect(resolveLocalIncludeTarget({ site: null, page: `public;${ulid}` })).toEqual({
			category: null,
			unixName: ulid.toLowerCase(),
		});
		expect(resolveLocalIncludeTarget({ site: "scp-jp", page: `public:${ulid}` })).toEqual({
			category: null,
			unixName: ulid.toLowerCase(),
		});
	});

	test("retains an explicit category for named pages", () => {
		expect(resolveLocalIncludeTarget({ site: "scp-jp", page: "credit:start" })).toEqual({
			category: "credit",
			unixName: "start",
		});
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
