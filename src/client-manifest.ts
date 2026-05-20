// manifest.json は client build 後に dist/.vite/ に生成される。
// build 順を `vite build --mode client && vite build` にすることで SSR build 時に
// 解決済みとなり、SSR バンドルにインライン化される（Workers 上で require/import.meta が不要）
import manifest from "../dist/.vite/manifest.json";

type ManifestEntry = {
	file: string;
	src?: string;
	isEntry?: boolean;
};

type Manifest = Record<string, ManifestEntry>;

const m = manifest as Manifest;

export function getClientScriptPath(entry: string): string {
	const key = `src/client/${entry}.ts`;
	const e = m[key];
	if (!e) return `/static/${entry}.js`;
	return `/${e.file}`;
}
