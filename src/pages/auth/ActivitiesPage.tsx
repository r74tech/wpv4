import type { FC } from "hono/jsx";

type Revision = {
	pagePath: string;
	revisionNumber: number;
	title: string;
	comment: string | null;
	createdAt: string | null;
};

type Props = {
	revisions: Revision[];
};

export const ActivitiesPage: FC<Props> = ({ revisions }) => (
	<>
		<div id="page-title"><span>My Activities</span></div>
		<div id="page-content">
			{revisions.length === 0 ? (
				<p>No activities yet.</p>
			) : (
				<table class="page-history">
					<tbody>
						<tr>
							<td><strong>Page</strong></td>
							<td><strong>Rev</strong></td>
							<td><strong>Title</strong></td>
							<td><strong>Comment</strong></td>
							<td><strong>Date</strong></td>
						</tr>
						{revisions.map((r) => (
							<tr>
								<td><a href={`/${r.pagePath}`}>{r.pagePath}</a></td>
								<td>{String(r.revisionNumber)}</td>
								<td>{r.title}</td>
								<td>{r.comment ?? ""}</td>
								<td>{r.createdAt ?? ""}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	</>
);
