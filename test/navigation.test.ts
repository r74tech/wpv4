import { describe, expect, test } from "bun:test";
import { normalizePagePath, shouldReloadPage } from "../src/client/navigation";

describe("normalizePagePath", () => {
	test("removes a fragment from the current page path", () => {
		expect(normalizePagePath("credit:start#u-credit-view")).toBe("credit:start");
	});

	test("removes query parameters without dropping Wikidot URL parameter segments", () => {
		expect(normalizePagePath("/system:page-tags/tag/test/offset/20?view=compact")).toBe(
			"system:page-tags/tag/test/offset/20",
		);
	});

	test("preserves CJK page paths", () => {
		expect(normalizePagePath("/public:theme#overview")).toBe("public:theme");
	});

	test("uses main for an empty path", () => {
		expect(normalizePagePath("/#top")).toBe("main");
	});

	test("preserves a malformed percent escape instead of throwing", () => {
		expect(normalizePagePath("/public:100%theme#top")).toBe("public:100%theme");
	});
});

describe("shouldReloadPage", () => {
	test("does not reload for a fragment change on the rendered page", () => {
		expect(shouldReloadPage("credit:start", "credit:start#u-credit-view")).toBe(false);
	});

	test("reloads when history moves to a different page", () => {
		expect(shouldReloadPage("credit:start", "main#toc0")).toBe(true);
	});

	test("reloads when no page has been rendered yet", () => {
		expect(shouldReloadPage(null, "main#toc0")).toBe(true);
	});
});
