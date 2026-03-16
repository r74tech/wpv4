import type { FC } from "hono/jsx";

type Props = {
	user: {
		name: string;
		unixName: string;
		wikidotId: number;
		createdAt: string | null;
		lastLoginAt: string | null;
	};
};

export const SettingsPage: FC<Props> = ({ user }) => (
	<>
		<div id="page-title"><span>Settings</span></div>
		<div id="page-content">
			<h2>Profile</h2>
			<table class="wiki-content-table">
				<tr><td><strong>Name</strong></td><td>{user.name}</td></tr>
				<tr><td><strong>Unix Name</strong></td><td>{user.unixName}</td></tr>
				<tr><td><strong>Wikidot ID</strong></td><td>{String(user.wikidotId)}</td></tr>
				<tr><td><strong>Registered</strong></td><td>{user.createdAt ?? ""}</td></tr>
				<tr><td><strong>Last Login</strong></td><td>{user.lastLoginAt ?? ""}</td></tr>
			</table>

			<h2>Passkeys</h2>
			<div id="passkey-list">
				<p>Loading passkeys...</p>
			</div>
			<div id="passkey-actions">
				<button id="btn-register-passkey" type="button">Register new Passkey</button>
			</div>
		</div>
	</>
);
