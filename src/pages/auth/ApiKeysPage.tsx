import type { FC } from "hono/jsx";
import { RelativeDateTime } from "@/components/RelativeDateTime";
import { API_KEY_SCOPES, API_KEY_SCOPE_DESCRIPTIONS } from "@/lib/api-key";
import type { ListedApiKey } from "@/services/api-keys";

type Props = {
	apiKeys: ListedApiKey[];
};

function ScopeCheckboxes({ checked = [] }: { checked?: readonly string[] }) {
	return (
		<div class="api-key-scope-options">
			{API_KEY_SCOPES.map((scope) => (
				<label>
					<input
						type="checkbox"
						name="api-key-scope"
						value={scope}
						checked={checked.includes(scope)}
					/>
					<span>
						<strong>{scope}</strong>
						<small>{API_KEY_SCOPE_DESCRIPTIONS[scope]}</small>
					</span>
				</label>
			))}
		</div>
	);
}

function DialogHeader({
	id,
	title,
	description,
}: {
	id: string;
	title: string;
	description: string;
}) {
	return (
		<div class="api-key-dialog-header">
			<div>
				<h2 id={id}>{title}</h2>
				<p>{description}</p>
			</div>
			<button
				type="button"
				class="dialog-close"
				data-action="close-api-key-dialog"
				aria-label="Close"
			>
				×
			</button>
		</div>
	);
}

export const ApiKeysPage: FC<Props> = ({ apiKeys }) => (
	<>
		<div class="api-page-header">
			<div>
				<a href="/user/settings" class="page-back-link">
					← Settings
				</a>
				<h1>API keys</h1>
				<p>Scoped credentials for the external page API.</p>
			</div>
			<button type="button" class="btn btn-primary" data-action="create-api-key">
				Create API key
			</button>
		</div>

		<div id="api-key-status" />

		{apiKeys.length === 0 ? (
			<div class="empty-state api-key-empty">
				<strong>No API keys yet</strong>
				<span>Create a scoped key when an external tool needs access.</span>
			</div>
		) : (
			<div class="api-key-list">
				{apiKeys.map((key) => {
					const dialogId = `api-key-edit-${key.id}`;
					return (
						<div class="api-key-item" data-api-key-id={String(key.id)}>
							<div class="api-key-summary">
								<div class="api-key-heading">
									<strong>{key.name}</strong>
									<span class={`api-key-status is-${key.status}`}>{key.status}</span>
								</div>
								<code>{key.hint}</code>
								<div class="api-key-scopes">{key.scopes.join(" · ")}</div>
								<dl class="api-key-dates">
									<dt>Created</dt>
									<dd>
										<RelativeDateTime value={key.createdAt} />
									</dd>
									<dt>Last used</dt>
									<dd>
										<RelativeDateTime value={key.lastUsedAt} empty="Never" />
									</dd>
									<dt>Expires</dt>
									<dd>
										<RelativeDateTime value={key.expiresAt} empty="Never" />
									</dd>
								</dl>
							</div>
							<div class="api-key-actions">
								{key.status === "active" ? (
									<button
										type="button"
										class="btn btn-sm"
										data-action="edit-api-key"
										data-dialog-id={dialogId}
									>
										Edit
									</button>
								) : null}
								{key.status === "active" ? (
									<button type="button" class="btn btn-danger btn-sm" data-action="revoke-api-key">
										Revoke
									</button>
								) : null}
								<button type="button" class="btn btn-danger btn-sm" data-action="delete-api-key">
									Delete
								</button>
							</div>

							{key.status === "active" ? (
								<dialog class="api-key-dialog" id={dialogId} aria-labelledby={`${dialogId}-title`}>
									<form class="api-key-edit-form">
										<DialogHeader
											id={`${dialogId}-title`}
											title="Edit API key"
											description="Changes apply immediately to clients using this key."
										/>
										<div data-api-key-dialog-status />
										<label class="field-label">
											Name
											<input name="name" type="text" maxlength={100} required value={key.name} />
										</label>
										<fieldset>
											<legend>Scopes</legend>
											<ScopeCheckboxes checked={key.scopes} />
										</fieldset>
										<div class="api-key-dialog-actions">
											<button type="button" class="btn" data-action="close-api-key-dialog">
												Cancel
											</button>
											<button type="submit" class="btn btn-primary">
												Save changes
											</button>
										</div>
									</form>
								</dialog>
							) : null}
						</div>
					);
				})}
			</div>
		)}

		<dialog
			class="api-key-dialog"
			id="api-key-create-dialog"
			aria-labelledby="api-key-create-title"
		>
			<form id="api-key-create-form" class="api-key-form">
				<DialogHeader
					id="api-key-create-title"
					title="Create API key"
					description="Grant only the scopes this client needs."
				/>
				<div data-api-key-dialog-status />
				<label class="field-label">
					Name
					<input id="api-key-name" name="name" type="text" maxlength={100} required />
				</label>
				<fieldset>
					<legend>Scopes</legend>
					<ScopeCheckboxes />
				</fieldset>
				<label class="field-label">
					Expires
					<select id="api-key-expiry" name="expiry">
						<option value="30">30 days</option>
						<option value="90" selected>
							90 days
						</option>
						<option value="365">365 days</option>
						<option value="never">Never</option>
					</select>
				</label>
				<div class="api-key-dialog-actions">
					<button type="button" class="btn" data-action="close-api-key-dialog">
						Cancel
					</button>
					<button type="submit" class="btn btn-primary">
						Create API key
					</button>
				</div>
			</form>
		</dialog>

		<dialog
			class="api-key-dialog api-key-created-dialog"
			id="api-key-created-dialog"
			aria-labelledby="api-key-created-title"
		>
			<div id="api-key-created" />
		</dialog>
	</>
);
