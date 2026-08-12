import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/utils/html";
import { getClientScriptPath } from "../client-manifest";
import { formatDocumentTitle } from "../lib/document-title";
import {
	renderLoginStatus,
	renderPageOptions,
	renderSidebarActions,
	type PageActionState,
	type ShellUser,
} from "../lib/shell-ui";

type NavContent = {
	html: string;
	styles: string[];
};

type Props = PropsWithChildren<{
	sidebar: NavContent | null;
	topbar: NavContent | null;
	pageStyles?: string[];
	title?: string;
	user: ShellUser | null;
	filesDomain: string;
	pageActions?: {
		path: string;
		page: PageActionState;
	};
}>;

export const WikidotShell: FC<Props> = ({
	children,
	sidebar,
	topbar,
	pageStyles,
	title = "",
	user,
	filesDomain,
	pageActions,
}) => {
	const clientScript = getClientScriptPath("main");
	const navigationStyles = [...(sidebar?.styles ?? []), ...(topbar?.styles ?? [])];
	const resolvedPageStyles = pageStyles ?? [];
	const pageOptions = pageActions
		? renderPageOptions(user !== null, pageActions.path, pageActions.page)
		: "";

	return (
		<>
			{raw("<!DOCTYPE html>")}
			<html lang="ja">
				<head>
					<meta charset="UTF-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1.0" />
					<title>{formatDocumentTitle(title)}</title>
					<link href="/static/style.css" rel="stylesheet" />
					{navigationStyles.length > 0 && <style>{raw(navigationStyles.join("\n"))}</style>}
					{resolvedPageStyles.length > 0 && (
						<style id="wdpr-page-styles">{raw(resolvedPageStyles.join("\n"))}</style>
					)}
				</head>
				<body id="html-body" data-files-domain={filesDomain.replace(/\/$/, "")}>
					<div id="skrollr-body">
						<a name="page-top" />
						<div id="container-wrap-wrap">
							<div id="container-wrap">
								<div id="container">
									<div id="header">
										<h1>
											<a href="/">
												<span>Wikitext Previewer</span>
											</a>
										</h1>
										<h2>
											<span />
										</h2>
										<div id="search-top-box" class="form-search">
											<form id="search-top-box-form" action="dummy" class="input-append">
												<input
													id="search-top-box-input"
													class="text empty search-query"
													type="text"
													name="query"
													value=""
													placeholder="Search this site"
												/>
												<input class="button btn" type="submit" name="search" value="Search" />
											</form>
										</div>
										<div id="top-bar">{raw(topbar?.html ?? "")}</div>
										<div id="login-status">{raw(renderLoginStatus(user, filesDomain))}</div>
										<div id="header-extra-div-1">
											<span />
										</div>
										<div id="header-extra-div-2">
											<span />
										</div>
										<div id="header-extra-div-3">
											<span />
										</div>
									</div>
									<div id="content-wrap">
										<div id="side-bar">
											<div id="side-bar-actions">{raw(renderSidebarActions(user !== null))}</div>
											<div>{raw(sidebar?.html ?? "")}</div>
										</div>
										<div id="main-content">
											{children}
											<div id="page-info-break" />
											<div id="page-options-container">
												<div id="page-info" />
												<div id="page-options-bottom" class="page-options-bottom">
													{raw(pageOptions)}
												</div>
											</div>
											<div id="page-options-area-bottom" />
											<div id="action-area" />
										</div>
									</div>
									<div id="footer" style={{ display: "block", visibility: "visible" }}>
										<div class="options" style={{ display: "block", visibility: "visible" }} />
										Powered by WPv4 + WDPR
									</div>
									<div id="license-area" class="license-area" />
									<div id="extrac-div-1" />
									<div id="extrac-div-2" />
									<div id="extrac-div-3" />
								</div>
							</div>
							<div id="extra-div-1">
								<span />
							</div>
							<div id="extra-div-2">
								<span />
							</div>
							<div id="extra-div-3">
								<span />
							</div>
							<div id="extra-div-4">
								<span />
							</div>
							<div id="extra-div-5">
								<span />
							</div>
						</div>
					</div>
					<script type="module" src={clientScript} />
				</body>
			</html>
		</>
	);
};
