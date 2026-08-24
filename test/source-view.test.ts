import { describe, expect, test } from "bun:test";
import { renderSourceWithIncludeLinks } from "../src/client/source-view";

describe("renderSourceWithIncludeLinks", () => {
	test("escapes source and links only recognized include targets", () => {
		const html = renderSourceWithIncludeLinks(
			"plain <tag>\n" +
				"inline [[include not-a-directive]]\n" +
				"[[include credit:start]]\n" +
				"[[include public;01ARZ3NDEKTSV4RRFFQ69G5FAV]]\n" +
				'[[include :scp-jp:component:image-block | name="CE46.jpg"]]',
		);

		expect(html).toContain("plain &lt;tag&gt;");
		expect(html).toContain("inline [[include not-a-directive]]");
		expect(html).not.toContain('data-path="not-a-directive"');
		expect(html).toContain(
			'[[include <a href="javascript:;" data-action="source" data-include-source data-path="credit:start">credit:start</a>]]',
		);
		expect(html).toContain(
			'[[include <a href="javascript:;" data-action="source" data-include-source data-path="public;01ARZ3NDEKTSV4RRFFQ69G5FAV">public;01ARZ3NDEKTSV4RRFFQ69G5FAV</a>]]',
		);
		expect(html).toContain(
			'[[include <a href="javascript:;" data-action="source" data-include-source data-path="component:image-block">:scp-jp:component:image-block</a> | name="CE46.jpg"]]',
		);

		const malformed = Array(1_000).fill("[[include broken").join("\n");
		expect(renderSourceWithIncludeLinks(malformed)).toBe(malformed);
	});
});
