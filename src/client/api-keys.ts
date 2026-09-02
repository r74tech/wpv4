import type { ApiKeyExpiryDays, ApiKeyScope } from "../lib/api-key";

type Dependencies = {
	origin: string;
	fetch(input: string, init?: RequestInit): Promise<Response>;
	confirm(message: string): boolean;
	reload(): void;
	copyText(value: string): Promise<void>;
	showCreatedKey(key: string): void;
	showError(message: string): void;
	setCreatePending?(pending: boolean): void;
};

type CreateInput = {
	name: string;
	scopes: ApiKeyScope[];
	expiresInDays: ApiKeyExpiryDays;
};

async function errorMessage(response: Response): Promise<string> {
	try {
		const value: unknown = await response.json();
		if (
			typeof value === "object" &&
			value !== null &&
			"error" in value &&
			typeof value.error === "string"
		) {
			return value.error;
		}
	} catch {}
	return response.statusText || "Request failed";
}

export function createApiKeyManager(dependencies: Dependencies): {
	create(input: CreateInput): Promise<void>;
	update(id: number, patch: { name: string; scopes: ApiKeyScope[] }): Promise<void>;
	revoke(id: number): Promise<void>;
	remove(id: number): Promise<void>;
	copy(value: string): Promise<void>;
} {
	const mutationHeaders = {
		"Content-Type": "application/json",
		Origin: dependencies.origin,
	};
	let createInFlight: Promise<void> | null = null;

	async function request(path: string, init: RequestInit): Promise<Response | null> {
		const response = await dependencies.fetch(path, init);
		if (response.ok) return response;
		dependencies.showError(await errorMessage(response));
		return null;
	}

	async function create(input: CreateInput): Promise<void> {
		if (createInFlight) return createInFlight;
		dependencies.setCreatePending?.(true);
		const operation = (async () => {
			const response = await request("/api/web/api-keys", {
				method: "POST",
				headers: mutationHeaders,
				body: JSON.stringify({
					name: input.name,
					scopes: input.scopes,
					expires_in_days: input.expiresInDays,
				}),
			});
			if (!response) return;
			const value: unknown = await response.json();
			if (
				typeof value !== "object" ||
				value === null ||
				!("key" in value) ||
				typeof value.key !== "string"
			) {
				dependencies.showError("Invalid API response");
				return;
			}
			dependencies.showCreatedKey(value.key);
		})();
		createInFlight = operation.finally(() => {
			createInFlight = null;
			dependencies.setCreatePending?.(false);
		});
		return createInFlight;
	}

	return {
		create,
		async update(id, patch): Promise<void> {
			const response = await request(`/api/web/api-keys/${id}`, {
				method: "PATCH",
				headers: mutationHeaders,
				body: JSON.stringify(patch),
			});
			if (response) dependencies.reload();
		},
		async revoke(id): Promise<void> {
			if (!dependencies.confirm("Revoke this API key? Existing clients will stop working.")) return;
			const response = await request(`/api/web/api-keys/${id}/revoke`, {
				method: "POST",
				headers: mutationHeaders,
				body: "{}",
			});
			if (response) dependencies.reload();
		},
		async remove(id): Promise<void> {
			if (!dependencies.confirm("Delete this API key record? This cannot be undone.")) return;
			const response = await request(`/api/web/api-keys/${id}`, {
				method: "DELETE",
				headers: mutationHeaders,
			});
			if (response) dependencies.reload();
		},
		copy(value): Promise<void> {
			return dependencies.copyText(value);
		},
	};
}
