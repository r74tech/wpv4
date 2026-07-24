import { jsxRenderer } from "hono/jsx-renderer";
import { raw } from "hono/utils/html";
import { getClientScriptPath } from "./client-manifest";
import { APPLICATION_TITLE } from "./lib/document-title";
import { renderAuthUserNav } from "./lib/shell-ui";
import type { AppEnv } from "./types/env";

export const authRenderer = jsxRenderer<AppEnv>(({ children }, c) => {
	const clientScript = getClientScriptPath("auth");
	const user = c.get("user");
	return (
		<html lang="ja">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{APPLICATION_TITLE}</title>
				<link href="/static/auth.css" rel="stylesheet" />
			</head>
			<body>
				<div class="auth-shell">
					<header class="auth-header">
						<a href="/" class="auth-logo">
							Wikitext Previewer
						</a>
						<nav class="auth-nav" id="auth-user-nav">
							{raw(renderAuthUserNav(user))}
						</nav>
					</header>
					<main class="auth-main">{children}</main>
				</div>
				<script type="module" src={clientScript} />
			</body>
		</html>
	);
});
