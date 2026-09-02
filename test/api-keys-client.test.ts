import { describe, expect, test } from "bun:test";
import { createApiKeyManager } from "../src/client/api-keys";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("API key client", () => {
	test("creates a key and exposes the plaintext only to the reveal callback", async () => {
		const requests: { input: string; init?: RequestInit }[] = [];
		let revealed = "";
		const manager = createApiKeyManager({
			origin: "https://example.com",
			async fetch(input, init) {
				requests.push({ input, init });
				return jsonResponse({ key: "wpv4_secret", id: 1 }, 201);
			},
			confirm: () => true,
			reload: () => {},
			copyText: async () => {},
			showCreatedKey: (key) => {
				revealed = key;
			},
			showError: () => {},
		});

		await manager.create({
			name: "Claude",
			scopes: ["pages:read", "pages:write"],
			expiresInDays: 90,
		});

		expect(requests).toHaveLength(1);
		expect(requests[0].input).toBe("/api/web/api-keys");
		expect(requests[0].init?.headers).toEqual({
			"Content-Type": "application/json",
			Origin: "https://example.com",
		});
		expect(JSON.parse(String(requests[0].init?.body))).toEqual({
			name: "Claude",
			scopes: ["pages:read", "pages:write"],
			expires_in_days: 90,
		});
		expect(revealed).toBe("wpv4_secret");
	});

	test("coalesces repeated create submissions while a request is in flight", async () => {
		let resolveResponse!: (response: Response) => void;
		const response = new Promise<Response>((resolve) => (resolveResponse = resolve));
		let calls = 0;
		const pendingStates: boolean[] = [];
		const manager = createApiKeyManager({
			origin: "https://example.com",
			fetch: async () => {
				calls += 1;
				return response;
			},
			confirm: () => true,
			reload: () => {},
			copyText: async () => {},
			showCreatedKey: () => {},
			showError: () => {},
			setCreatePending: (pending) => pendingStates.push(pending),
		});
		const input = {
			name: "Claude",
			scopes: ["pages:read" as const],
			expiresInDays: 30 as const,
		};
		const first = manager.create(input);
		const second = manager.create(input);
		expect(calls).toBe(1);
		resolveResponse(jsonResponse({ key: "wpv4_secret" }, 201));
		await Promise.all([first, second]);
		expect(pendingStates).toEqual([true, false]);
	});

	test("does not revoke when confirmation is declined", async () => {
		let calls = 0;
		const manager = createApiKeyManager({
			origin: "https://example.com",
			fetch: async () => {
				calls += 1;
				return jsonResponse({ ok: true });
			},
			confirm: () => false,
			reload: () => {},
			copyText: async () => {},
			showCreatedKey: () => {},
			showError: () => {},
		});

		await manager.revoke(3);
		expect(calls).toBe(0);
	});

	test("reports API errors without reloading", async () => {
		let error = "";
		let reloaded = false;
		const manager = createApiKeyManager({
			origin: "https://example.com",
			fetch: async () => jsonResponse({ error: "Denied" }, 403),
			confirm: () => true,
			reload: () => {
				reloaded = true;
			},
			copyText: async () => {},
			showCreatedKey: () => {},
			showError: (message) => {
				error = message;
			},
		});

		await manager.remove(2);
		expect(error).toBe("Denied");
		expect(reloaded).toBe(false);
	});
});
