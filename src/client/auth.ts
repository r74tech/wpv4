import {
	startRegistration,
	startAuthentication,
	browserSupportsWebAuthnAutofill,
} from "@simplewebauthn/browser";
import { createPasskeyLogin } from "./passkey-login";
import { applyRelativeTimeLabels } from "./relative-time";

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
		if (target.dataset.action === "delete-passkey") {
			const id = target.dataset.passkeyId;
			if (id) deletePasskey(id);
		}
	});
});
