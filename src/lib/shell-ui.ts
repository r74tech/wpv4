export type ShellUser = {
	name: string;
};

export type PageActionState = {
	category: string;
	unix_name: string;
	visibility: "public" | "share" | "private";
	can_edit: boolean;
	can_manage: boolean;
};

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return escapeText(value).replace(/"/g, "&quot;");
}

export function renderLoginStatus(user: ShellUser | null): string {
	if (!user) {
		return '<a href="/auth/login" id="login-link">Sign in / Create account</a>';
	}

	return (
		`<span class="printuser">${escapeText(user.name)}</span>` +
		` | <a id="account-topbutton" href="javascript:;">▼</a>` +
		`<div id="account-options"><ul>` +
		`<li><a href="/user/settings">Settings</a></li>` +
		`<li><a href="/user/activities">Activities</a></li>` +
		`<li><a href="javascript:;" id="btn-logout">Sign out</a></li>` +
		`</ul></div>`
	);
}

export function renderSidebarActions(authenticated: boolean): string {
	if (authenticated) {
		return (
			`<div class="side-block">` +
			`<div class="heading"><p>New page</p></div>` +
			`<div class="menu-item"><a href="/new?type=public">+ Public</a></div>` +
			`<div class="menu-item"><a href="/new?type=share">+ Share</a></div>` +
			`<div class="menu-item"><a href="/new?type=private">+ Private</a></div>` +
			`</div>`
		);
	}

	return (
		`<div class="side-block">` +
		`<div class="heading"><p>Account</p></div>` +
		`<div class="menu-item"><a href="/auth/login">Sign in / Create account</a></div>` +
		`</div>`
	);
}

export function renderPageOptions(
	authenticated: boolean,
	path: string,
	page: PageActionState,
): string {
	if (!authenticated) return "";

	const escapedPath = escapeAttribute(path);
	const parts: string[] = [];
	if (page.can_edit) {
		parts.push(`<a href="javascript:;" data-action="edit" data-path="${escapedPath}">Edit</a>`);
	}
	parts.push(`<a href="javascript:;" data-action="source" data-path="${escapedPath}">Source</a>`);
	parts.push(`<a href="javascript:;" data-action="history" data-path="${escapedPath}">History</a>`);

	if (page.can_manage) {
		const currentPath = escapeAttribute(`${page.category}:${page.unix_name}`);
		const visibilities: PageActionState["visibility"][] = ["public", "share", "private"];
		for (const target of visibilities) {
			if (target === page.visibility) continue;
			parts.push(
				`<a href="javascript:;" data-action="toggle-visibility"` +
					` data-ulid="${escapeAttribute(page.unix_name)}" data-target="${target}"` +
					` data-current-path="${currentPath}"` +
					` data-current-category="${page.visibility}">Make ${target}</a>`,
			);
		}
	}

	return parts.join("");
}

export function renderAuthUserNav(user: ShellUser | null): string {
	if (!user) return "";

	return (
		`<a href="/user/settings">Settings</a>` +
		`<a href="/user/activities">Activities</a>` +
		`<a href="/">Wiki</a>` +
		`<span>${escapeText(user.name)}</span>`
	);
}
