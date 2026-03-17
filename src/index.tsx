import { Hono } from "hono";
import { cors } from "hono/cors";
import { api } from "./routes/api";
import { auth } from "./routes/auth";
import { passkeyApi } from "./routes/passkey-api";
import { renderer } from "./renderer";
import { resolveSession } from "./middleware/session";
import type { AppEnv } from "./types/env";

const app = new Hono<AppEnv>();

// セッション解決を全ルートに適用
app.use("*", resolveSession);

// CORS (API用)
app.use("/api/*", cors());

// ルート登録
app.route("/api", api);
app.route("/api/passkeys", passkeyApi);
app.route("/auth", auth);

// SSR: HTML shell を返す（コンテンツはクライアントJSが読み込む）
app.use("*", renderer);
app.get("*", (c) => {
	return c.render(<div id="app-loading">Loading...</div>);
});

export default app;
