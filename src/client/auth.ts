import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

function $(sel: string): HTMLElement | null {
	return document.querySelector(sel);
}

// --- Passkey登録 ---

async function registerPasskey() {
	const status = $("#passkey-status");

	try {
		const optRes = await fetch("/api/passkeys/register/options");
		if (!optRes.ok) throw new Error("Failed to get options");
		const options = await optRes.json();

		const result = await startRegistration({ optionsJSON: options });

		const name = window.prompt("Name this passkey (optional):", "") ?? "";

		const verifyRes = await fetch("/api/passkeys/register/verify", {
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

	const res = await fetch(`/api/passkeys/${id}`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json", Origin: window.location.origin },
	});

	if (res.ok) {
		window.location.reload();
	}
}

// --- Passkeyログイン ---

async function loginWithPasskey() {
	const status = $("#login-status-msg");
	try {
		const optRes = await fetch("/api/passkeys/login/options");
		if (!optRes.ok) throw new Error("Failed to get options");
		const options = await optRes.json();

		const result = await startAuthentication({ optionsJSON: options });

		const verifyRes = await fetch("/api/passkeys/login/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: window.location.origin },
			body: JSON.stringify({ response: result }),
		});

		if (!verifyRes.ok) {
			const err = (await verifyRes.json()) as { error: string };
			throw new Error(err.error);
		}

		window.location.href = "/";
	} catch (err) {
		if (err instanceof Error && err.name === "NotAllowedError") return;
		if (status) {
			status.innerHTML = `<div class="status-msg error">${err instanceof Error ? err.message : "Login failed"}</div>`;
		}
	}
}

// --- 初期化 ---

document.addEventListener("DOMContentLoaded", () => {
	$("#btn-register-passkey")?.addEventListener("click", registerPasskey);
	$("#btn-passkey-login")?.addEventListener("click", loginWithPasskey);

	document.addEventListener("click", (e) => {
		const target = e.target as HTMLElement;
		if (target.dataset.action === "delete-passkey") {
			const id = target.dataset.passkeyId;
			if (id) deletePasskey(id);
		}
	});
});
