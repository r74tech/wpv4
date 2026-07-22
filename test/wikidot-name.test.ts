import { describe, expect, test } from "bun:test";
import { normalizeWikidotCategoryName } from "../src/lib/wikidot-name";

describe("normalizeWikidotCategoryName", () => {
	test("normalizes an ASCII display name to Wikidot unix form", () => {
		expect(normalizeWikidotCategoryName("News Foo")).toBe("news-foo");
	});

	test("collapses punctuation and repeated separators", () => {
		expect(normalizeWikidotCategoryName("--News__and!!Notes--")).toBe("news-and-notes");
	});

	test("preserves a single leading underscore", () => {
		expect(normalizeWikidotCategoryName("_Default")).toBe("_default");
	});

	test("removes characters outside Wikidot's ASCII unix-name alphabet", () => {
		expect(normalizeWikidotCategoryName(" 日本語 ")).toBe("");
	});

	test("keeps empty input empty", () => {
		expect(normalizeWikidotCategoryName("")).toBe("");
	});
});
