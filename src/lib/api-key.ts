export const API_KEY_SCOPES = [
	"pages:read",
	"pages:render",
	"pages:write",
	"pages:delete",
	"pages:visibility",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
	"pages:read": "Read page metadata and source",
	"pages:render": "Render a saved page as HTML",
	"pages:write": "Create and update pages",
	"pages:delete": "Delete pages you manage",
	"pages:visibility": "Change page visibility",
};

export const API_KEY_EXPIRY_DAYS = [30, 90, 365] as const;
export type ApiKeyExpiryDays = (typeof API_KEY_EXPIRY_DAYS)[number] | null;

export const MAX_ACTIVE_API_KEYS = 20;

const API_KEY_PREFIX = "wpv4_";
const API_KEY_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const scopeSet = new Set<string>(API_KEY_SCOPES);

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function generateApiKey(): { plaintext: string; hint: string } {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const body = base64Url(bytes);
	return {
		plaintext: `${API_KEY_PREFIX}${body}`,
		hint: `${API_KEY_PREFIX}${body.slice(0, 4)}…${body.slice(-4)}`,
	};
}

export function isApiKeyFormat(value: string): boolean {
	return (
		value.startsWith(API_KEY_PREFIX) &&
		API_KEY_BODY_PATTERN.test(value.slice(API_KEY_PREFIX.length))
	);
}

export function parseScopes(value: string): ApiKeyScope[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return [
		...new Set(
			parsed.filter(
				(scope): scope is ApiKeyScope => typeof scope === "string" && scopeSet.has(scope),
			),
		),
	];
}

export function hasScope(scopes: readonly ApiKeyScope[], required: ApiKeyScope): boolean {
	return scopes.includes(required);
}

export function apiKeyStatus(
	key: { revokedAt: string | null; expiresAt: string | null },
	now: Date,
): "active" | "revoked" | "expired" {
	if (key.revokedAt !== null) return "revoked";
	if (key.expiresAt !== null && new Date(key.expiresAt).getTime() <= now.getTime())
		return "expired";
	return "active";
}
