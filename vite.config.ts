import build from "@hono/vite-build/cloudflare-workers";
import devServer from "@hono/vite-dev-server";
import adapter from "@hono/vite-dev-server/cloudflare";
import { defineConfig } from "vite";

export default defineConfig(({ mode, command }) => {
	// Client-only build (for static assets)
	if (mode === "client") {
		return {
			build: {
				rollupOptions: {
					input: {
						main: "src/client/main.ts",
						auth: "src/client/auth.ts",
					},
					output: {
						entryFileNames: "static/[name].[hash].js",
					},
				},
				outDir: "dist",
				emptyOutDir: false,
				manifest: true,
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

	return {
		resolve: {
			alias: {
				"@": "/src",
			},
		},
		plugins,
	};
});
