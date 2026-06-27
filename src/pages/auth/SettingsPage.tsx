import type { FC } from "hono/jsx";

type Passkey = {
	id: number;
	name: string;
	createdAt: string | null;
};

type Props = {
	user: {
		name: string;
		unixName: string;
		wikidotId: number;
		createdAt: string | null;
		lastLoginAt: string | null;
	};
	passkeys: Passkey[];
};

function formatDateTime(value: string | null): string {
	if (!value) return "—";
	const normalized = value.includes("T") ? value : value.replace(" ", "T");
	const date = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString("ja-JP", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

export const SettingsPage: FC<Props> = ({ user, passkeys }) => (
	<>
		<h1>Settings</h1>

		<h2>Profile</h2>
		<div class="card">
			<dl class="info-grid">
				<dt>Name</dt>
				<dd>{user.name}</dd>
				<dt>Unix Name</dt>
				<dd>{user.unixName}</dd>
				<dt>Wikidot ID</dt>
				<dd>{String(user.wikidotId)}</dd>
				<dt>Registered</dt>
				<dd>{formatDateTime(user.createdAt)}</dd>
				<dt>Last Login</dt>
				<dd>{formatDateTime(user.lastLoginAt)}</dd>
			</dl>
		</div>

		<h2>Passkeys</h2>
		<div id="passkey-status" />
		{passkeys.length === 0 ? (
			<div class="empty-state">No passkeys registered</div>
		) : (
			<div class="passkey-list">
				{passkeys.map((pk) => (
					<div class="passkey-item" data-passkey-id={String(pk.id)}>
						<div class="passkey-item-info">
							<span class="passkey-item-name">{pk.name || "Unnamed passkey"}</span>
							<span class="passkey-item-date">{formatDateTime(pk.createdAt)}</span>
						</div>
						<button
							type="button"
							class="btn btn-danger btn-sm"
							data-action="delete-passkey"
							data-passkey-id={String(pk.id)}
						>
							Delete
						</button>
					</div>
				))}
			</div>
		)}
		<div style="margin-top: 1rem">
			<button type="button" class="btn btn-primary" id="btn-register-passkey">
				Register new Passkey
			</button>
		</div>
	</>
);
