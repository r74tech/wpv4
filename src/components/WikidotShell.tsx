import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/utils/html";
import { getClientScriptPath } from "../client-manifest";

type NavContent = {
	html: string;
	styles: string[];
};

type Props = PropsWithChildren<{
	sidebar: NavContent | null;
	topbar: NavContent | null;
	pageStyles?: string[];
}>;

export const WikidotShell: FC<Props> = ({ children, sidebar, topbar, pageStyles }) => {
	const clientScript = getClientScriptPath("main");
	const allStyles = [...(sidebar?.styles ?? []), ...(topbar?.styles ?? []), ...(pageStyles ?? [])];

	return (
		<>
			{raw("<!DOCTYPE html>")}
			<html lang="ja">
				<head>
					<meta charset="UTF-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1.0" />
					<title>Wikitext Previewer v4</title>
					<link href="/static/style.css" rel="stylesheet" />
					{allStyles.length > 0 && <style>{raw(allStyles.join("\n"))}</style>}
				</head>
				<body id="html-body">
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
										<div id="login-status">
											<span />
										</div>
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
											<div id="side-bar-actions" />
											<div>{raw(sidebar?.html ?? "")}</div>
										</div>
										<div id="main-content">
											{children}
											<div id="page-info-break" />
											<div id="page-options-container">
												<div id="page-info" />
												<div id="page-options-bottom" class="page-options-bottom" />
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
