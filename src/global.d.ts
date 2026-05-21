// vite alias で解決される client manifest（build時は実 manifest、 dev/typecheck時は空 stub）
declare module "client-manifest-data" {
	const manifest: Record<
		string,
		{
			file: string;
			src?: string;
			isEntry?: boolean;
		}
	>;
	export default manifest;
}
