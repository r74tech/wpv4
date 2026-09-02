import {
	startRegistration,
	startAuthentication,
	browserSupportsWebAuthnAutofill,
} from "@simplewebauthn/browser";
import { createPasskeyLogin } from "./passkey-login";
import { createApiKeyManager } from "./api-keys";
import { applyRelativeTimeLabels } from "./relative-time";
import { API_KEY_SCOPES, type ApiKeyExpiryDays, type ApiKeyScope } from "../lib/api-key";

function $(sel: string): HTMLElement | null {
	return document.querySelector(sel);
}

type Theme = "light" | "dark";

function currentTheme(): Theme {
	const theme = document.documentElement.dataset.theme;
	if (theme === "light" || theme === "dark") return theme;
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeToggle(button: HTMLElement): void {
	const nextTheme = currentTheme() === "dark" ? "light" : "dark";
	const label = `Switch to ${nextTheme} mode`;
	const icon = button.querySelector<HTMLElement>("#theme-toggle-icon");
	if (icon) icon.textContent = nextTheme === "dark" ? "☾" : "☀";
	button.dataset.targetTheme = nextTheme;
	button.setAttribute("aria-label", label);
	button.setAttribute("title", label);
}

function readScopes(form: HTMLFormElement): ApiKeyScope[] {
	return [...form.querySelectorAll<HTMLInputElement>('input[name="api-key-scope"]:checked')]
		.map((input) => API_KEY_SCOPES.find((scope) => scope === input.value))
		.filter((scope): scope is ApiKeyScope => scope !== undefined);
}

function readExpiry(value: string): ApiKeyExpiryDays {
	if (value === "30") return 30;
	if (value === "90") return 90;
	if (value === "365") return 365;
	return null;
}

function showApiKeyError(message: string): void {
	const status =
		document.querySelector<HTMLElement>(".api-key-dialog[open] [data-api-key-dialog-status]") ??
		$("#api-key-status");
	if (!status) return;
	const error = document.createElement("div");
	error.className = "status-msg error";
	error.textContent = message;
	status.replaceChildren(error);
}

function showCreatedApiKey(key: string): void {
	const container = $("#api-key-created");
	const dialog = document.querySelector<HTMLDialogElement>("#api-key-created-dialog");
	if (!container || !dialog) return;
	document
		.querySelectorAll<HTMLDialogElement>(".api-key-dialog[open]")
		.forEach((open) => open.close());
	const card = document.createElement("div");
	card.className = "api-key-secret";
	const label = document.createElement("strong");
	label.id = "api-key-created-title";
	label.textContent = "API key created";
	const note = document.createElement("p");
	note.textContent = "This key is shown only once. Copy it before leaving or reloading this page.";
	const code = document.createElement("code");
	code.textContent = key;
	const actions = document.createElement("div");
	actions.className = "api-key-secret-actions";
	const copy = document.createElement("button");
	copy.type = "button";
	copy.className = "btn btn-primary btn-sm";
	copy.dataset.action = "copy-api-key";
	copy.textContent = "Copy";
	const dismiss = document.createElement("button");
	dismiss.type = "button";
	dismiss.className = "btn btn-sm";
	dismiss.dataset.action = "dismiss-api-key";
	dismiss.textContent = "Dismiss";
	actions.append(copy, dismiss);
	card.append(label, note, code, actions);
	container.replaceChildren(card);
	dialog.showModal();
}

function openApiKeyDialog(id: string): void {
	const dialog = document.getElementById(id);
	if (!(dialog instanceof HTMLDialogElement)) return;
	dialog.querySelector<HTMLElement>("[data-api-key-dialog-status]")?.replaceChildren();
	dialog.showModal();
	dialog.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
}

// --- Passkey登録 ---

async function registerPasskey() {
	const status = $("#passkey-status");

	try {
		const optRes = await fetch("/api/web/passkeys/register/options");
		if (!optRes.ok) throw new Error("Failed to get options");
		const options = await optRes.json();

		const result = await startRegistration({ optionsJSON: options });

		const name = window.prompt("Name this passkey (optional):", "") ?? "";

		const verifyRes = await fetch("/api/web/passkeys/register/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: window.location.origin },
			body: JSON.stringify({ response: result, name }),
		});

		if (!verifyRes.ok) {
			const err = (await verifyRes.json()) as { error: string };
			throw new Error(err.error);
		}

		if (status) {
			status.innerHTML = '<div class="status-msg success">Passkey registered. Reloading...</div>';
		}
		window.location.reload();
	} catch (err) {
		if (err instanceof Error && err.name === "NotAllowedError") return;
		if (status) {
			status.innerHTML = `<div class="status-msg error">${err instanceof Error ? err.message : "Registration failed"}</div>`;
		}
	}
}

// --- Passkey削除 ---

async function deletePasskey(id: string) {
	if (!window.confirm("Delete this passkey?")) return;

	const res = await fetch(`/api/web/passkeys/${id}`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json", Origin: window.location.origin },
	});

	if (res.ok) {
		window.location.reload();
	}
}

// --- 初期化 ---

document.addEventListener("DOMContentLoaded", () => {
	$("#btn-register-passkey")?.addEventListener("click", registerPasskey);
	applyRelativeTimeLabels();

	const apiKeyManager = createApiKeyManager({
		origin: window.location.origin,
		fetch: (input, init) => window.fetch(input, init),
		confirm: (message) => window.confirm(message),
		reload: () => window.location.reload(),
		copyText: (value) => navigator.clipboard.writeText(value),
		showCreatedKey: showCreatedApiKey,
		showError: showApiKeyError,
		setCreatePending: (pending) => {
			const button = document.querySelector<HTMLButtonElement>(
				'#api-key-create-form button[type="submit"]',
			);
			if (button) button.disabled = pending;
		},
	});

	const apiKeyCreateForm = document.querySelector<HTMLFormElement>("#api-key-create-form");
	apiKeyCreateForm?.addEventListener("submit", (event) => {
		event.preventDefault();
		const name =
			apiKeyCreateForm.querySelector<HTMLInputElement>('input[name="name"]')?.value.trim() ?? "";
		const scopes = readScopes(apiKeyCreateForm);
		const expiry =
			apiKeyCreateForm.querySelector<HTMLSelectElement>('select[name="expiry"]')?.value ?? "never";
		if (scopes.length === 0) {
			showApiKeyError("Select at least one scope");
			return;
		}
		void apiKeyManager.create({ name, scopes, expiresInDays: readExpiry(expiry) });
	});

	document.querySelectorAll<HTMLFormElement>(".api-key-edit-form").forEach((form) => {
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const item = form.closest<HTMLElement>("[data-api-key-id]");
			const id = Number(item?.dataset.apiKeyId);
			const name = form.querySelector<HTMLInputElement>('input[name="name"]')?.value.trim() ?? "";
			const scopes = readScopes(form);
			if (!Number.isInteger(id) || id <= 0 || scopes.length === 0) {
				showApiKeyError("Enter a name and select at least one scope");
				return;
			}
			void apiKeyManager.update(id, { name, scopes });
		});
	});
	document.querySelectorAll<HTMLDialogElement>(".api-key-dialog").forEach((dialog) => {
		dialog.addEventListener("close", () => dialog.querySelector<HTMLFormElement>("form")?.reset());
		if (dialog.classList.contains("api-key-created-dialog")) {
			dialog.addEventListener("cancel", (event) => event.preventDefault());
		}
	});

	const themeToggle = $("#theme-toggle");
	if (themeToggle) {
		updateThemeToggle(themeToggle);
		themeToggle.addEventListener("click", () => {
			const theme: Theme = currentTheme() === "dark" ? "light" : "dark";
			document.documentElement.dataset.theme = theme;
			try {
				localStorage.setItem("auth-theme", theme);
			} catch {}
			updateThemeToggle(themeToggle);
		});
	}

	const passkeyLogin = createPasskeyLogin({
		origin: window.location.origin,
		fetch: (input, init) => window.fetch(input, init),
		startAuthentication,
		browserSupportsAutofill: browserSupportsWebAuthnAutofill,
		showError(message) {
			const status = $("#login-status-msg");
			if (!status) return;
			const error = document.createElement("div");
			error.className = "status-msg error";
			error.textContent = message;
			status.replaceChildren(error);
		},
		navigate(path) {
			window.location.href = path;
		},
	});

	$("#btn-passkey-login")?.addEventListener("click", () => {
		void passkeyLogin.startExplicit();
	});
	if ($("#passkey-autofill")) {
		void passkeyLogin.startConditional();
	}

	$("#btn-logout")?.addEventListener("click", async () => {
		const response = await fetch("/auth/logout", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: window.location.origin },
		});
		if (response.ok) {
			window.location.href = "/auth/login";
		}
	});

	document.addEventListener("click", (e) => {
		const target = e.target as HTMLElement;
		if (target.dataset.action === "create-api-key") {
			openApiKeyDialog("api-key-create-dialog");
		}
		if (target.dataset.action === "delete-passkey") {
			const id = target.dataset.passkeyId;
			if (id) deletePasskey(id);
		}
		const item = target.closest<HTMLElement>("[data-api-key-id]");
		const id = Number(item?.dataset.apiKeyId);
		if (target.dataset.action === "edit-api-key") {
			const dialogId = target.dataset.dialogId;
			if (dialogId) openApiKeyDialog(dialogId);
		}
		if (target.dataset.action === "close-api-key-dialog") {
			target.closest<HTMLDialogElement>("dialog")?.close();
		}
		if (Number.isInteger(id) && id > 0 && target.dataset.action === "revoke-api-key") {
			void apiKeyManager.revoke(id);
		}
		if (Number.isInteger(id) && id > 0 && target.dataset.action === "delete-api-key") {
			void apiKeyManager.remove(id);
		}
		if (target.dataset.action === "copy-api-key") {
			const key = $("#api-key-created code")?.textContent;
			if (key) void apiKeyManager.copy(key);
		}
		if (target.dataset.action === "dismiss-api-key") {
			target.closest<HTMLDialogElement>("dialog")?.close();
			$("#api-key-created")?.replaceChildren();
			window.location.reload();
		}
		if (
			target instanceof HTMLDialogElement &&
			target.classList.contains("api-key-dialog") &&
			!target.classList.contains("api-key-created-dialog")
		) {
			target.close();
		}
	});
});
