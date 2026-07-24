import type { FC } from "hono/jsx";

export const PageTitle: FC<{ title: string }> = ({ title }) => (
	<div id="page-title" hidden={title.length === 0}>
		{title.length > 0 ? <span>{title}</span> : null}
	</div>
);
