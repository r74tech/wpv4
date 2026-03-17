import { jsxRenderer } from "hono/jsx-renderer";
import { getClientScriptPath } from "./client-manifest";

export const authRenderer = jsxRenderer(({ children }) => {
	const clientScript = getClientScriptPath("auth");
	return (
		<html lang="ja">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Wikitext Previewer v4</title>
				<link href="/static/auth.css" rel="stylesheet" />
			</head>
			<body>
				<div class="auth-shell">
					<header class="auth-header">
						<a href="/" class="auth-logo">Wikitext Previewer</a>
						<nav class="auth-nav" id="auth-user-nav" />
					</header>
					<main class="auth-main">{children}</main>
				</div>
				<script type="module" src={clientScript} />
			</body>
		</html>
	);
});
