import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

type StartAuthenticationOptions = {
	optionsJSON: PublicKeyCredentialRequestOptionsJSON;
	useBrowserAutofill: boolean;
};

export type PasskeyLoginDependencies = {
	origin: string;
	fetch(input: string, init?: RequestInit): Promise<Response>;
	startAuthentication(options: StartAuthenticationOptions): Promise<AuthenticationResponseJSON>;
	browserSupportsAutofill(): Promise<boolean>;
	showError(message: string): void;
	navigate(path: string): void;
};

type AuthenticationOptionsResponse = {
	stateKey: string;
	options: PublicKeyCredentialRequestOptionsJSON;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseAuthenticationOptions(value: unknown): PublicKeyCredentialRequestOptionsJSON {
	if (!isRecord(value) || typeof value.challenge !== "string") {
		throw new Error("Invalid authentication options");
	}
	if (value.rpId !== undefined && typeof value.rpId !== "string") {
		throw new Error("Invalid authentication options");
	}
	if (value.timeout !== undefined && typeof value.timeout !== "number") {
		throw new Error("Invalid authentication options");
	}
	if (
		value.userVerification !== undefined &&
		value.userVerification !== "required" &&
		value.userVerification !== "preferred" &&
		value.userVerification !== "discouraged"
	) {
		throw new Error("Invalid authentication options");
	}
	if (value.allowCredentials !== undefined) {
		throw new Error("Conditional UI requires discoverable credentials");
	}
	return {
		challenge: value.challenge,
		...(value.rpId === undefined ? {} : { rpId: value.rpId }),
		...(value.timeout === undefined ? {} : { timeout: value.timeout }),
		...(value.userVerification === undefined ? {} : { userVerification: value.userVerification }),
	};
}

function parseOptionsResponse(value: unknown): AuthenticationOptionsResponse {
	if (!isRecord(value) || typeof value.stateKey !== "string" || !isRecord(value.options)) {
		throw new Error("Invalid authentication options");
	}
	return {
		stateKey: value.stateKey,
		options: parseAuthenticationOptions(value.options),
	};
}

async function responseError(response: Response): Promise<string> {
	try {
		const value: unknown = await response.json();
		if (isRecord(value) && typeof value.error === "string") return value.error;
	} catch {
		// The status text remains the only available error description.
	}
	return response.statusText || "Authentication failed";
}

function isCeremonyAborted(error: unknown): boolean {
	return isRecord(error) && error.code === "ERROR_CEREMONY_ABORTED";
}

function isUserCancellation(error: unknown): boolean {
	if (error instanceof Error && error.name === "NotAllowedError") return true;
	return isRecord(error) && isRecord(error.cause) && error.cause.name === "NotAllowedError";
}

export function createPasskeyLogin(dependencies: PasskeyLoginDependencies): {
	startConditional(): Promise<void>;
	startExplicit(): Promise<void>;
} {
	let optionsRequest: Promise<AuthenticationOptionsResponse> | null = null;

	function loadOptions(): Promise<AuthenticationOptionsResponse> {
		if (!optionsRequest) {
			optionsRequest = dependencies
				.fetch("/api/passkeys/login/options")
				.then(async (response) => {
					if (!response.ok) throw new Error("Failed to get authentication options");
					return parseOptionsResponse(await response.json());
				})
				.catch((error: unknown) => {
					optionsRequest = null;
					throw error;
				});
		}
		return optionsRequest;
	}

	async function authenticate(useBrowserAutofill: boolean): Promise<void> {
		try {
			const { options, stateKey } = await loadOptions();
			const authenticationResponse = await dependencies.startAuthentication({
				optionsJSON: options,
				useBrowserAutofill,
			});
			const verificationResponse = await dependencies.fetch("/api/passkeys/login/verify", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: dependencies.origin },
				body: JSON.stringify({ stateKey, response: authenticationResponse }),
			});
			if (!verificationResponse.ok) {
				throw new Error(await responseError(verificationResponse));
			}
			optionsRequest = null;
			dependencies.navigate("/");
		} catch (error) {
			if (isCeremonyAborted(error)) return;
			optionsRequest = null;
			if (isUserCancellation(error)) return;
			dependencies.showError(error instanceof Error ? error.message : "Authentication failed");
		}
	}

	return {
		async startConditional(): Promise<void> {
			let supported = false;
			try {
				supported = await dependencies.browserSupportsAutofill();
			} catch {
				return;
			}
			if (!supported) return;
			await authenticate(true);
		},
		startExplicit(): Promise<void> {
			return authenticate(false);
		},
	};
}
