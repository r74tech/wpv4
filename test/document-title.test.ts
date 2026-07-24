import { describe, expect, test } from "bun:test";
import { formatDocumentTitle } from "../src/lib/document-title";

describe("formatDocumentTitle", () => {
	test("uses the application title when the page title is empty", () => {
		expect(formatDocumentTitle("")).toBe("Wikitext Previewer v4");
	});

	test("prefixes an ASCII page title", () => {
		expect(formatDocumentTitle("Sandbox")).toBe("Sandbox - Wikitext Previewer v4");
	});

	test("prefixes a CJK page title", () => {
		expect(formatDocumentTitle("テストページ")).toBe("テストページ - Wikitext Previewer v4");
	});
});
