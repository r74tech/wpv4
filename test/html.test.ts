import { describe, expect, test } from "bun:test";
import { escapeHtml } from "../src/client/dom";
import { escapeAttribute } from "../src/lib/html";

describe("HTML escaping", () => {
	test("escapes text without a DOM", () => {
		expect(escapeHtml(`日本語 <script> & "quoted"`)).toBe(`日本語 &lt;script&gt; &amp; "quoted"`);
	});

	test("also escapes double quotes in attributes", () => {
		expect(escapeAttribute(`<img alt="x"> &`)).toBe("&lt;img alt=&quot;x&quot;&gt; &amp;");
	});
});
