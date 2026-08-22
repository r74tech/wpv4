import { jsxRenderer } from "hono/jsx-renderer";
import { raw } from "hono/utils/html";
import { getClientScriptPath } from "./client-manifest";
import { APPLICATION_TITLE } from "./lib/document-title";
import { renderAuthUserNav } from "./lib/shell-ui";
import type { AppEnv } from "./types/env";

const themeInitScript = `try{const theme=localStorage.getItem("auth-theme");if(theme==="light"||theme==="dark")document.documentElement.dataset.theme=theme}catch{}`;

export const authRenderer = jsxRenderer<AppEnv>(({ children }, c) => {
	const clientScript = getClientScriptPath("auth");
	const user = c.get("user");
	return (
		<html lang="ja">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{APPLICATION_TITLE}</title>
				<script>{raw(themeInitScript)}</script>
				<link href="/static/auth.css" rel="stylesheet" />
			</head>
			<body>
				<div class="auth-shell">
					<header class="auth-header">
						<a href="/" class="auth-logo">
							Wikitext Previewer
						</a>
						<div class="auth-header-actions">
							<nav class="auth-nav" id="auth-user-nav">
								{raw(renderAuthUserNav(user))}
							</nav>
							<button
								type="button"
								class="theme-toggle"
								id="theme-toggle"
								aria-label="Switch color theme"
								title="Switch color theme"
							>
								<span id="theme-toggle-icon" aria-hidden="true">
									◐
								</span>
							</button>
						</div>
					</header>
					<main class="auth-main">{children}</main>
				</div>
				<script type="module" src={clientScript} />
			</body>
		</html>
	);
});
