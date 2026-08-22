import type { FC } from "hono/jsx";
import type { LastLoginMethod } from "@/lib/last-login-method";

type Props = {
	lastLoginMethod: LastLoginMethod | null;
};

export const LoginPage: FC<Props> = ({ lastLoginMethod }) => (
	<>
		<div style="min-height:80vh;display:flex;align-items:center;justify-content:center">
			<div style="max-width:400px;width:100%;text-align:center">
				<h1 style="font-size:1.5rem;margin-bottom:0.5rem">Wikitext Previewer</h1>
				<p style="color:var(--text-muted);margin-bottom:2rem;font-size:0.9rem">
					Sign in to continue
				</p>

				<div class="login-methods">
					<a href="/auth/oauth" class="btn btn-primary login-method">
						<span>Sign in with Wikidot</span>
						{lastLoginMethod?.method === "wikidot" && (
							<span class="last-used-badge">Last used</span>
						)}
					</a>
					<div id="passkey-login-section">
						<button type="button" id="btn-passkey-login" class="btn login-method">
							<span>Sign in with Passkey</span>
							{lastLoginMethod?.method === "passkey" && (
								<span class="last-used-details">
									<span class="last-used-badge">Last used</span>
									<span class="last-passkey-name">{lastLoginMethod.passkeyName}</span>
								</span>
							)}
						</button>
					</div>
					<input
						type="text"
						id="passkey-autofill"
						autocomplete="webauthn"
						class="sr-only"
						tabindex={-1}
						aria-hidden="true"
					/>
				</div>

				<div id="login-status-msg" style="margin-top:1rem" />
			</div>
		</div>
	</>
);
