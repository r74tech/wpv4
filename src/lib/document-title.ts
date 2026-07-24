export const APPLICATION_TITLE = "Wikitext Previewer v4";

export function formatDocumentTitle(pageTitle: string): string {
	return pageTitle ? `${pageTitle} - ${APPLICATION_TITLE}` : APPLICATION_TITLE;
}
