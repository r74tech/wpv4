type ManifestEntry = {
	file: string;
	src?: string;
	isEntry?: boolean;
};

type Manifest = Record<string, ManifestEntry>;

let manifest: Manifest | null = null;

function loadManifest(): Manifest {
	if (manifest) return manifest;
	try {
		// @ts-expect-error manifest.json only exists after client build
		manifest = require("../dist/.vite/manifest.json") as Manifest;
	} catch {
		manifest = {};
	}
	return manifest!;
}

export function getClientScriptPath(entry: string): string {
	if (!import.meta.env.PROD) {
		return `/src/client/${entry}.ts`;
	}
	const m = loadManifest();
	const key = `src/client/${entry}.ts`;
	const e = m[key];
	if (!e) return `/static/${entry}.js`;
	return `/${e.file}`;
}
