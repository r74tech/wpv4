import { describe, expect, test } from "bun:test";
import { buildPreviewRequest } from "../src/client/preview";

describe("preview request builder", () => {
	test("uses the edit target for page context and the latest rendered URL", () => {
		let renderedPagePath = "docs:guide/offset/1";
		const context = {
			mode: "edit" as const,
			pagePath: "docs:guide",
			getRenderedPagePath: () => renderedPagePath,
		};

		expect(buildPreviewRequest("first", ["a"], context)).toEqual({
			source: "first",
			page_path: "docs:guide",
			tags: ["a"],
			url_path: "/docs:guide/offset/1",
		});

		renderedPagePath = "docs:guide/offset/2/page2_limit/3";
		expect(buildPreviewRequest("second", ["b"], context).url_path).toBe(
			"/docs:guide/offset/2/page2_limit/3",
		);
	});

	test("builds a visibility-qualified placeholder context for new pages", () => {
		expect(
			buildPreviewRequest("new source", ["tag"], {
				mode: "new",
				category: "private",
			}),
		).toEqual({
			source: "new source",
			page_path: "private:preview",
			tags: ["tag"],
			url_path: "/private:preview",
		});
	});

	test("uses revision page context with a fallback when no rendered URL exists", () => {
		expect(
			buildPreviewRequest("old source", ["old"], {
				mode: "revision",
				pagePath: "public:01arz3ndektsv4rrffq69g5fav",
				getRenderedPagePath: () => null,
			}),
		).toEqual({
			source: "old source",
			page_path: "public:01arz3ndektsv4rrffq69g5fav",
			tags: ["old"],
			url_path: "/public:01arz3ndektsv4rrffq69g5fav",
		});
	});
});
