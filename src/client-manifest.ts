// manifest.json は client build 後に dist/.vite/ に生成される。
// build 順を `vite build --mode client && vite build` にすることで SSR build 時に
// 解決済みとなり、SSR バンドルにインライン化される（Workers 上で require/import.meta が不要）。
//
// clean checkout の typecheck / dev:wrangler / vite dev で dist/ がない場合に備え、
// vite.config.ts の resolve.alias で client-manifest-data を環境別に振り分け、
// build 時は実 manifest、それ以外は src/_manifest-stub.json を解決する。
import manifest from "client-manifest-data";

type ManifestEntry = {
	file: string;
	src?: string;
	isEntry?: boolean;
};

type Manifest = Record<string, ManifestEntry>;

const m = manifest as Manifest;

// import.meta.env.DEV は Vite build 時に true/false リテラル置換される。
// wrangler 単独 bundle (esbuild) では define されないため、 safe access で undefined 防御
// （undefined なら本番扱いで manifest を見る）。
const isDevBuild = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

export function getClientScriptPath(entry: string): string {
	// dev (vite dev) では vite dev server が `/src/client/*.ts` を直接配信する。
	// hash 付き `/static/*.js` は dist 配下にあり dev server からは配信されないため
	// dev 時は src パスを返す。
	if (isDevBuild) {
		return `/src/client/${entry}.ts`;
	}
	const key = `src/client/${entry}.ts`;
	const e = m[key];
	if (!e) return `/static/${entry}.js`;
	return `/${e.file}`;
}
