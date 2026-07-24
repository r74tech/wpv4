import { describe, expect, mock, test } from "bun:test";

mock.module("client-manifest-data", () => ({ default: {} }));

const { WikidotShell } = await import("../src/components/WikidotShell");
const { PageTitle } = await import("../src/components/PageTitle");

async function renderShell(title?: string) {
	return String(
		await WikidotShell({
			children: "<main>content</main>",
			sidebar: { html: "<p>side</p>", styles: [".side { color: blue; }"] },
			topbar: { html: "<p>top</p>", styles: [".top { color: green; }"] },
			pageStyles: [".page { color: red; }"],
			title,
			user: null,
		}),
	);
}

describe("WikidotShell document title", () => {
	test("uses the application title when the page title is omitted", async () => {
		const html = await renderShell();

		expect(html).toContain("<title>Wikitext Previewer v4</title>");
	});

	test("prefixes and escapes the page title", async () => {
		const html = await renderShell("A < B");

		expect(html).toContain("<title>A &lt; B - Wikitext Previewer v4</title>");
	});
});

describe("WikidotShell styles", () => {
	test("renders page styles in the element managed by SPA navigation", async () => {
		const html = await renderShell();

		expect(html).toContain('<style id="wdpr-page-styles">.page { color: red; }</style>');
	});

	test("keeps navigation styles outside the page style element", async () => {
		const html = await renderShell();
		const pageStyle = html.match(/<style id="wdpr-page-styles">([\s\S]*?)<\/style>/)?.[1];

		expect(pageStyle).toBe(".page { color: red; }");
		expect(html).toContain(".side { color: blue; }\n.top { color: green; }");
	});

	test("omits the managed page style element when a page has no styles", async () => {
		const html = String(
			await WikidotShell({
				children: "content",
				sidebar: { html: "", styles: [".side { color: blue; }"] },
				topbar: null,
				user: null,
			}),
		);

		expect(html).not.toContain('id="wdpr-page-styles"');
		expect(html).toContain(".side { color: blue; }");
	});
});

describe("WikidotShell initial UI", () => {
	test("renders signed-out login and sidebar UI inside the existing placeholders", async () => {
		const html = await renderShell();

		expect(html).toContain(
			'<div id="login-status"><a href="/auth/login" id="login-link">Sign in / Create account</a></div>',
		);
		expect(html).toContain('<div id="side-bar-actions"><div class="side-block">');
		expect(html).toContain("<p>Account</p>");
		expect(html).toContain('<body id="html-body">');
		expect(html).not.toContain("data-authenticated");
		expect(html).not.toContain("data-ssr");
	});

	test("renders authenticated login, sidebar, and page options", async () => {
		const html = String(
			await WikidotShell({
				children: "content",
				sidebar: null,
				topbar: null,
				user: { name: "Owner" },
				pageActions: {
					path: "private:01arz3ndektsv4rrffq69g5fav",
					page: {
						category: "private",
						unix_name: "01arz3ndektsv4rrffq69g5fav",
						visibility: "private",
						can_edit: true,
						can_manage: true,
					},
				},
			}),
		);

		expect(html).toContain('<span class="printuser">Owner</span>');
		expect(html).toContain('id="btn-logout"');
		expect(html).toContain('<a href="/new?type=public">+ Public</a>');
		expect(html).toContain('data-action="edit"');
		expect(html).toContain('data-action="toggle-visibility"');
	});

	test("keeps page options empty when no page action state is supplied", async () => {
		const html = String(
			await WikidotShell({
				children: "content",
				sidebar: null,
				topbar: null,
				user: { name: "Owner" },
			}),
		);

		expect(html).toContain('<div id="page-options-bottom" class="page-options-bottom"></div>');
	});
});

describe("PageTitle", () => {
	test("does not render a title box when the title is empty", async () => {
		const html = String(await PageTitle({ title: "" }));

		expect(html).toBe('<div id="page-title" hidden=""></div>');
	});

	test("renders and escapes a non-empty title", async () => {
		const html = String(await PageTitle({ title: "A < B" }));

		expect(html).toBe('<div id="page-title"><span>A &lt; B</span></div>');
	});
});
