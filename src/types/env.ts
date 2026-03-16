export type Bindings = {
	DB: D1Database;
	R2: R2Bucket;
	OAUTH_PROVIDER_URL: string;
	CLIENT_ID: string;
	CLIENT_SECRET: string;
	SESSION_SECRET: string;
	FILES_DOMAIN: string;
};

export type Variables = {
	user: {
		id: number;
		wikidotId: number;
		name: string;
		unixName: string;
	} | null;
};

export type AppEnv = {
	Bindings: Bindings;
	Variables: Variables;
};
