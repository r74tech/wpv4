import { describe, expect, test } from "bun:test";
import { renderAvatarUser } from "../src/lib/user-markup";

describe("avatar user markup", () => {
	test("uses the Wikidot ID for the files-domain avatar", () => {
		expect(
			renderAvatarUser(
				{ name: "User", unixName: "user", wikidotId: 4053112 },
				"https://files.example.com/",
			),
		).toBe(
			'<span class="printuser avatarhover"><a href="https://www.wikidot.com/user:info/user"><img class="small" src="https://files.example.com/avatar?userId=4053112" alt="User" /></a><a href="https://www.wikidot.com/user:info/user">User</a></span>',
		);
	});

	test("uses the default ID and escapes every HTML context for an unknown user", () => {
		const html = renderAvatarUser(
			{ name: '<Admin> & "Owner"', unixName: '日本語/<&"', wikidotId: null },
			"https://files.example.com/",
		);

		expect(html).toContain("/avatar?userId=-1");
		expect(html).toContain("user:info/%E6%97%A5%E6%9C%AC%E8%AA%9E%2F%3C%26%22");
		expect(html).toContain('alt="&lt;Admin&gt; &amp; &quot;Owner&quot;"');
		expect(html).toContain('&lt;Admin&gt; &amp; "Owner"');
		expect(html).not.toContain("<Admin>");
	});
});
