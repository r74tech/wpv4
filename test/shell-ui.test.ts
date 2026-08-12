import { describe, expect, test } from "bun:test";
import {
	renderAuthUserNav,
	renderLoginStatus,
	renderPageOptions,
	renderSidebarActions,
} from "../src/lib/shell-ui";

describe("renderLoginStatus", () => {
	test("renders the existing signed-out link", () => {
		expect(renderLoginStatus(null)).toBe(
			'<a href="/auth/login" id="login-link">Sign in / Create account</a>',
		);
	});

	test("renders the account menu and escapes an authenticated user name", () => {
		const html = renderLoginStatus(
			{ name: '日本語 <Admin> & "Owner"', unixName: "owner", wikidotId: 70 },
			"https://files.example.com/",
		);

		expect(html).toContain('<span class="printuser avatarhover">');
		expect(html).toContain('src="https://files.example.com/avatar?userId=70"');
		expect(html).toContain('alt="日本語 &lt;Admin&gt; &amp; &quot;Owner&quot;"');
		expect(html).toContain('id="account-topbutton"');
		expect(html).toContain('id="btn-logout"');
		expect(html).not.toContain("<Admin>");
	});
});

describe("renderSidebarActions", () => {
	test("renders page creation links for an authenticated user", () => {
		const html = renderSidebarActions(true);

		expect(html).toContain('<a href="/new?type=public">+ Public</a>');
		expect(html).toContain('<a href="/new?type=share">+ Share</a>');
		expect(html).toContain('<a href="/new?type=private">+ Private</a>');
	});

	test("renders the existing account block for a signed-out user", () => {
		const html = renderSidebarActions(false);

		expect(html).toContain("<p>Account</p>");
		expect(html).toContain('href="/auth/login"');
		expect(html).not.toContain("/new?type=");
	});
});

describe("renderPageOptions", () => {
	const page = {
		category: "private",
		unix_name: "01arz3ndektsv4rrffq69g5fav",
		visibility: "private" as const,
		can_edit: true,
		can_manage: true,
	};

	test("renders no actions for a signed-out user", () => {
		expect(renderPageOptions(false, "main", page)).toBe("");
	});

	test("renders edit, source, history, and the other visibility targets", () => {
		const html = renderPageOptions(true, "private:01arz3ndektsv4rrffq69g5fav", page);

		expect(html).toContain('data-action="edit"');
		expect(html).toContain('data-action="source"');
		expect(html).toContain('data-action="history"');
		expect(html).toContain('data-target="public"');
		expect(html).toContain('data-target="share"');
		expect(html).not.toContain('data-target="private"');
	});

	test("omits edit and visibility actions when the server denies them", () => {
		const html = renderPageOptions(true, "guide", {
			...page,
			category: "_default",
			unix_name: "guide",
			visibility: "public",
			can_edit: false,
			can_manage: false,
		});

		expect(html).not.toContain('data-action="edit"');
		expect(html).toContain('data-action="source"');
		expect(html).toContain('data-action="history"');
		expect(html).not.toContain('data-action="toggle-visibility"');
	});

	test("escapes the existing data attributes without changing the application path", () => {
		const html = renderPageOptions(true, 'docs:日本語"<&', {
			...page,
			category: 'docs"<&',
			unix_name: '日本語"<&',
		});

		expect(html).toContain('data-path="docs:日本語&quot;&lt;&amp;"');
		expect(html).not.toContain('data-path="docs:日本語"<&"');
	});
});

describe("renderAuthUserNav", () => {
	test("renders no links for a signed-out user", () => {
		expect(renderAuthUserNav(null)).toBe("");
	});

	test("renders authenticated navigation with an escaped name", () => {
		const html = renderAuthUserNav({ name: "利用者 <One>", unixName: "one", wikidotId: 1 });

		expect(html).toContain('<a href="/user/settings">Settings</a>');
		expect(html).toContain('<a href="/user/activities">Activities</a>');
		expect(html).toContain('<a href="/">Wiki</a>');
		expect(html).toContain("<span>利用者 &lt;One&gt;</span>");
	});
});
