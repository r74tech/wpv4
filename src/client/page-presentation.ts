type PagePresentation = {
	title: string;
	html: string;
	styles: string[];
	tags: string[];
};

type PagePresentationTarget = {
	replaceStyles: (styles: string[]) => void;
	replaceTitle: (html: string, hidden: boolean) => void;
	replaceContent: (html: string) => void;
	replaceTags: (tags: string[]) => void;
};

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/** Install styles first so the browser never paints the next page without its page CSS. */
export function commitPagePresentation(
	presentation: PagePresentation,
	target: PagePresentationTarget,
): void {
	target.replaceStyles(presentation.styles);
	target.replaceTitle(
		presentation.title ? `<span>${escapeHtml(presentation.title)}</span>` : "",
		presentation.title.length === 0,
	);
	target.replaceContent(presentation.html);
	target.replaceTags(presentation.tags);
}
