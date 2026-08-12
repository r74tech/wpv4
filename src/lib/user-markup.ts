import { escapeAttribute, escapeHtml } from "./html";

export type AvatarUser = {
	name: string;
	unixName: string;
	wikidotId: number | null;
};

function replaceLoneSurrogates(value: string): string {
	return value.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"\uFFFD",
	);
}

export function userProfileUrl(unixName: string): string {
	const normalized = replaceLoneSurrogates(unixName.trim().toLowerCase());
	return `https://www.wikidot.com/user:info/${encodeURIComponent(normalized)}`;
}

export function userAvatarUrl(filesDomain: string, wikidotId: number | null): string {
	const id =
		wikidotId !== null && Number.isSafeInteger(wikidotId) && wikidotId > 0 ? wikidotId : -1;
	return `${filesDomain.replace(/\/$/, "")}/avatar?userId=${id}`;
}

export function renderAvatarUser(user: AvatarUser, filesDomain: string): string {
	const profileUrl = escapeAttribute(userProfileUrl(user.unixName));
	const avatarUrl = escapeAttribute(userAvatarUrl(filesDomain, user.wikidotId));
	const nameAttribute = escapeAttribute(user.name);
	const name = escapeHtml(user.name);
	return (
		`<span class="printuser avatarhover">` +
		`<a href="${profileUrl}"><img class="small" src="${avatarUrl}" alt="${nameAttribute}" /></a>` +
		`<a href="${profileUrl}">${name}</a>` +
		`</span>`
	);
}
