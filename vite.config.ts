import build from "@hono/vite-build/cloudflare-workers";
import devServer from "@hono/vite-dev-server";
import adapter from "@hono/vite-dev-server/cloudflare";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
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
	return {
		resolve: {
			alias: {
				"@": "/src",
			},
		},
		plugins: [
			build({
				entry: "src/index.tsx",
				outputDir: "dist",
			}),
			devServer({
				adapter: adapter({
					proxy: {
						persist: { path: ".wrangler/state/v3" },
					},
				}),
				entry: "src/index.tsx",
			}),
		],
	};
});
