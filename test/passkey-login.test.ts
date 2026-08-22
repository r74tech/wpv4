import { describe, expect, test } from "bun:test";
import { createPasskeyLogin, type PasskeyLoginDependencies } from "../src/client/passkey-login";

const credential = {
	id: "credential-1",
	rawId: "credential-1",
	response: {
		clientDataJSON: "client-data",
		authenticatorData: "authenticator-data",
		signature: "signature",
	},
	clientExtensionResults: {},
	type: "public-key" as const,
};

function optionsResponse(stateKey = "state-1"): Response {
	return Response.json({
		stateKey,
		options: { challenge: "challenge", rpId: "example.com", userVerification: "preferred" },
	});
}

function createDependencies(
	overrides: Partial<PasskeyLoginDependencies> = {},
): PasskeyLoginDependencies & {
	errors: string[];
	navigations: string[];
} {
	const state = {
		errors: [] as string[],
		navigations: [] as string[],
	};
	return {
		...state,
		origin: "https://example.com",
		fetch: async (input) =>
			input.endsWith("/options") ? optionsResponse() : Response.json({ ok: true }),
		startAuthentication: async () => credential,
		browserSupportsAutofill: async () => true,
		showError(message) {
			state.errors.push(message);
			this.errors = state.errors;
		},
		navigate(path) {
			state.navigations.push(path);
			this.navigations = state.navigations;
		},
		...overrides,
	};
}

describe("Passkey login client", () => {
	test("does not start Conditional UI in an unsupported browser", async () => {
		let fetches = 0;
		const dependencies = createDependencies({
			browserSupportsAutofill: async () => false,
			fetch: async () => {
				fetches += 1;
				return optionsResponse();
			},
		});

		await createPasskeyLogin(dependencies).startConditional();

		expect(fetches).toBe(0);
	});

	test("uses browser autofill and sends the matching state key for verification", async () => {
		const requests: Array<{ input: string; init?: RequestInit }> = [];
		const authenticationCalls: boolean[] = [];
		const dependencies = createDependencies({
			fetch: async (input, init) => {
				requests.push({ input, init });
				return input.endsWith("/options")
					? optionsResponse("conditional-state")
					: Response.json({ ok: true });
			},
			startAuthentication: async ({ useBrowserAutofill }) => {
				authenticationCalls.push(useBrowserAutofill);
				return credential;
			},
		});

		await createPasskeyLogin(dependencies).startConditional();

		expect(authenticationCalls).toEqual([true]);
		expect(requests).toHaveLength(2);
		expect(JSON.parse(String(requests[1].init?.body))).toEqual({
			stateKey: "conditional-state",
			response: credential,
		});
		expect(dependencies.navigations).toEqual(["/"]);
	});

	test("shares options when an explicit login aborts Conditional UI", async () => {
		let optionFetches = 0;
		const authenticationModes: boolean[] = [];
		let rejectConditional: ((reason: unknown) => void) | undefined;
		const dependencies = createDependencies({
			fetch: async (input) => {
				if (input.endsWith("/options")) {
					optionFetches += 1;
					return optionsResponse("shared-state");
				}
				return Response.json({ ok: true });
			},
			startAuthentication: async ({ useBrowserAutofill }) => {
				authenticationModes.push(useBrowserAutofill);
				if (authenticationModes.length === 1) {
					return new Promise((_, reject) => {
						rejectConditional = reject;
					});
				}
				rejectConditional?.({ code: "ERROR_CEREMONY_ABORTED" });
				return credential;
			},
		});
		const login = createPasskeyLogin(dependencies);
		const conditional = login.startConditional();
		await Promise.resolve();
		await Promise.resolve();
		const explicit = login.startExplicit();

		await Promise.all([conditional, explicit]);

		expect(optionFetches).toBe(1);
		expect(authenticationModes).toEqual([true, false]);
		expect(dependencies.errors).toEqual([]);
		expect(dependencies.navigations).toEqual(["/"]);
	});

	test("keeps state keys paired when two tabs receive options in reverse order", async () => {
		let resolveFirst: ((response: Response) => void) | undefined;
		let resolveSecond: ((response: Response) => void) | undefined;
		const verifiedStates: string[] = [];
		function tabDependencies(
			setResolver: (resolve: (response: Response) => void) => void,
		): PasskeyLoginDependencies {
			return createDependencies({
				fetch: async (input, init) => {
					if (input.endsWith("/options")) {
						return new Promise<Response>((resolve) => setResolver(resolve));
					}
					verifiedStates.push(JSON.parse(String(init?.body)).stateKey);
					return Response.json({ ok: true });
				},
			});
		}
		const first = createPasskeyLogin(tabDependencies((resolve) => (resolveFirst = resolve)));
		const second = createPasskeyLogin(tabDependencies((resolve) => (resolveSecond = resolve)));
		const firstLogin = first.startExplicit();
		const secondLogin = second.startExplicit();
		await Promise.resolve();

		resolveSecond?.(optionsResponse("state-2"));
		await Promise.resolve();
		resolveFirst?.(optionsResponse("state-1"));
		await Promise.all([firstLogin, secondLogin]);

		expect(verifiedStates).toEqual(["state-2", "state-1"]);
	});
});
