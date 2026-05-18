import type { FC } from "hono/jsx";

export const LoginPage: FC = () => (
	<>
		<div style="min-height:80vh;display:flex;align-items:center;justify-content:center">
			<div style="max-width:400px;width:100%;text-align:center">
				<h1 style="font-size:1.5rem;margin-bottom:0.5rem">Wikitext Previewer</h1>
				<p style="color:var(--text-muted);margin-bottom:2rem;font-size:0.9rem">
					Sign in to continue
				</p>

				<div style="display:flex;flex-direction:column;gap:0.75rem">
					<a
						href="/auth/oauth"
						class="btn btn-primary"
						style="padding:0.75rem 1.5rem;font-size:0.95rem"
					>
						Sign in with Wikidot
					</a>
					<div id="passkey-login-section">
						<button
							type="button"
							id="btn-passkey-login"
							class="btn"
							style="width:100%;padding:0.75rem 1.5rem;font-size:0.95rem"
						>
							Sign in with Passkey
						</button>
					</div>
				</div>

				<div id="login-status-msg" style="margin-top:1rem" />
			</div>
		</div>
	</>
);
