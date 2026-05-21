import build from "@hono/vite-build/cloudflare-workers";
import devServer from "@hono/vite-dev-server";
import adapter from "@hono/vite-dev-server/cloudflare";
import { defineConfig } from "vite";

export default defineConfig(({ mode, command }) => {
	// Client-only build: public/ に直接書き出して wrangler の assets.directory: "./public"
	// から配信されるようにする。 既存の public/static/*.css 等を消さないよう emptyOutDir: false
	// publicDir も false にしないと vite が public/ 内をコピーで上書きして無限ループになる
	if (mode === "client") {
		return {
			publicDir: false,
			build: {
				rollupOptions: {
					input: {
						main: "src/client/main.ts",
						auth: "src/client/auth.ts",
					},
					output: {
						entryFileNames: "static/[name].[hash].js",
						chunkFileNames: "assets/[name]-[hash].js",
					},
				},
				outDir: "public",
				emptyOutDir: false,
				manifest: ".vite/manifest.json",
			},
		};
	}

	// Default: SSR build with Hono
	// devServer は dev (`vite dev` / `vite serve`) のときのみ有効化する。
	// build 時に含めるとプロセスが exit せずビルドがハングする。
	const plugins = [
		build({
			entry: "src/index.tsx",
			outputDir: "dist",
		}),
	];
	if (command === "serve") {
		plugins.push(
			devServer({
				adapter: adapter({
					proxy: {
						persist: { path: ".wrangler/state/v3" },
					},
				}),
				entry: "src/index.tsx",
			}),
		);
	}

	// client-manifest-data alias:
	// - vite build (SSR) では実 manifest を inline 化（client build 後に存在）
	// - vite dev / typecheck では空 stub にフォールバック（public/.vite/ 未生成でも壊さない）
	const clientManifestPath =
		command === "build" ? "/public/.vite/manifest.json" : "/src/_manifest-stub.json";
	return {
		resolve: {
			alias: {
				"@": "/src",
				"client-manifest-data": clientManifestPath,
			},
		},
		// import.meta.env.PROD / DEV を build 時にリテラル置換して
		// Workers runtime (import.meta が limited) でも値が解決できるようにする
		define: {
			"import.meta.env.PROD": JSON.stringify(command !== "serve"),
			"import.meta.env.DEV": JSON.stringify(command === "serve"),
		},
		plugins,
	};
});
