export type PreviewCategory = "public" | "share" | "private";

export type PreviewRequestBody = {
	source: string;
	page_path: string;
	tags: string[];
	url_path: string;
};

type ExistingPagePreviewContext = {
	mode: "edit" | "revision";
	pagePath: string;
	getRenderedPagePath: () => string | null;
};

type NewPagePreviewContext = {
	mode: "new";
	category: PreviewCategory;
};

export type PreviewContext = ExistingPagePreviewContext | NewPagePreviewContext;

function withLeadingSlash(path: string): string {
	return `/${path.replace(/^\/+/, "")}`;
}

export function isPreviewCategory(value: string | undefined): value is PreviewCategory {
	return value === "public" || value === "share" || value === "private";
}

export function buildPreviewRequest(
	source: string,
	tags: string[],
	context: PreviewContext,
): PreviewRequestBody {
	if (context.mode === "new") {
		const pagePath = `${context.category}:preview`;
		return {
			source,
			page_path: pagePath,
			tags,
			url_path: withLeadingSlash(pagePath),
		};
	}

	return {
		source,
		page_path: context.pagePath,
		tags,
		url_path: withLeadingSlash(context.getRenderedPagePath() ?? context.pagePath),
	};
}
