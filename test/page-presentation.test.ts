import { describe, expect, test } from "bun:test";
import { commitPagePresentation } from "../src/client/page-presentation";

describe("commitPagePresentation", () => {
	test("installs page styles before replacing visible page DOM", () => {
		const operations: string[] = [];

		commitPagePresentation(
			{ title: "", html: '<div class="tag-cloud">tags</div>', styles: [".tag-cloud{}"], tags: [] },
			{
				replaceStyles: () => operations.push("styles"),
				replaceTitle: (html, hidden) => operations.push(`title:${html}:${hidden}`),
				replaceContent: () => operations.push("content"),
				replaceTags: () => operations.push("tags"),
			},
		);

		expect(operations).toEqual(["styles", "title::true", "content", "tags"]);
	});

	test("escapes and exposes a non-empty title", () => {
		let title: { html: string; hidden: boolean } | null = null;

		commitPagePresentation(
			{ title: "A < B", html: "", styles: [], tags: [] },
			{
				replaceStyles: () => {},
				replaceTitle: (html, hidden) => {
					title = { html, hidden };
				},
				replaceContent: () => {},
				replaceTags: () => {},
			},
		);

		expect(title).toEqual({ html: "<span>A &lt; B</span>", hidden: false });
	});
});
