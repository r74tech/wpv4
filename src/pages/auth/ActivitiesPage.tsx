import type { FC } from "hono/jsx";
import { RelativeDateTime } from "@/components/RelativeDateTime";

type Revision = {
	pagePath: string;
	revisionNumber: number;
	title: string;
	comment: string | null;
	createdAt: string | null;
};

type Pagination = {
	page: number;
	perPage: number;
	totalCount: number;
	totalPages: number;
};

type Props = {
	revisions: Revision[];
	pagination: Pagination;
	search: string;
};

export const ActivitiesPage: FC<Props> = ({ revisions, pagination, search }) => {
	const { page, totalCount, totalPages } = pagination;
	const baseUrl = "/user/activities";

	const pageLink = (p: number, extra?: string) => {
		const params = new URLSearchParams();
		params.set("page", String(p));
		if (search) params.set("q", search);
		if (extra) params.set("per_page", extra);
		return `${baseUrl}?${params}`;
	};

	return (
		<>
			<h1>Activities</h1>

			<form method="get" action={baseUrl} style="display:flex;gap:0.5rem;margin-bottom:1.5rem">
				<input
					type="text"
					name="q"
					value={search}
					placeholder="Search by page name..."
					style="flex:1;padding:0.5rem 0.75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:0.875rem"
				/>
				<button type="submit" class="btn">
					Search
				</button>
				{search && (
					<a href={baseUrl} class="btn">
						Clear
					</a>
				)}
			</form>

			{revisions.length === 0 ? (
				<div class="empty-state">{search ? `No results for "${search}"` : "No activities yet"}</div>
			) : (
				<>
					<div class="activity-table-scroll">
						<table class="activity-table">
							<thead>
								<tr>
									<th>Page</th>
									<th>Rev</th>
									<th>Date</th>
								</tr>
							</thead>
							<tbody>
								{revisions.map((r) => {
									const hasComment = Boolean(r.comment?.trim());
									return (
										<>
											<tr class={hasComment ? "activity-entry has-comment" : "activity-entry"}>
												<td>
													<a href={`/${r.pagePath}`}>{r.title || r.pagePath}</a>
												</td>
												<td>{String(r.revisionNumber)}</td>
												<td>
													<RelativeDateTime value={r.createdAt} empty="" />
												</td>
											</tr>
											{hasComment && (
												<tr class="activity-comment-row">
													<td colspan={3}>
														<span class="activity-comment-label">Comment:</span> {r.comment}
													</td>
												</tr>
											)}
										</>
									);
								})}
							</tbody>
						</table>
					</div>

					<div style="display:flex;justify-content:space-between;align-items:center;margin-top:1.5rem;font-size:0.85rem;color:var(--text-muted)">
						<span>{totalCount} total</span>
						<div style="display:flex;gap:0.5rem;align-items:center">
							{page > 1 ? (
								<a href={pageLink(page - 1)} class="btn btn-sm">
									&larr; Prev
								</a>
							) : (
								<span class="btn btn-sm" style="opacity:0.3;pointer-events:none">
									&larr; Prev
								</span>
							)}
							<span>
								{page} / {totalPages}
							</span>
							{page < totalPages ? (
								<a href={pageLink(page + 1)} class="btn btn-sm">
									Next &rarr;
								</a>
							) : (
								<span class="btn btn-sm" style="opacity:0.3;pointer-events:none">
									Next &rarr;
								</span>
							)}
						</div>
					</div>
				</>
			)}
		</>
	);
};
