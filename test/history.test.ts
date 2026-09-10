import { expect, test, spyOn } from "bun:test";
import {
	clearHistoryState,
	showHistory,
	showRevisionView,
	showRevisionCompare,
} from "../src/client/history";

test("history dates support SQLite and ISO timestamps in all revision views", async () => {
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const area = { innerHTML: "", style: { display: "" } };
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			querySelector: (selector: string) => {
				if (selector.includes('name="history-from"')) return { value: "0" };
				if (selector.includes('name="history-to"')) return { value: "1" };
				return ["#action-area", "#page-content", "#history-subarea"].includes(selector)
					? area
					: null;
			},
		},
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { location: { origin: "https://example.com" } },
	});
	let timestamp = "";
	const request = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const revision = {
			revision_number: 0,
			title: "",
			source: "",
			comment: "",
			created_by: null,
			created_by_name: null,
			created_by_unix_name: null,
			created_by_wikidot_id: null,
			created_at: timestamp,
			page_path: "public:test",
			tags: [],
		};
		return Response.json(
			String(input).includes("page-history")
				? {
						currentRevision: 0,
						revisions: [
							{
								revisionNumber: 0,
								title: "",
								comment: "",
								createdAt: timestamp,
								createdBy: null,
								createdByName: null,
								createdByUnixName: null,
								createdByWikidotId: null,
							},
						],
					}
				: String(input).includes("/preview")
					? { html: "", styles: [] }
					: revision,
		);
	});
	try {
		for (const show of [
			() => showHistory("public:test"),
			() => showRevisionView("public:test", 0),
			() => showRevisionCompare("public:test"),
		]) {
			timestamp = "2026-09-10 12:34:56";
			await show();
			const legacy = area.innerHTML;
			expect(legacy).toContain("2026");
			expect(legacy).not.toContain("Invalid Date");
			for (const value of ["2026-09-10T12:34:56.000Z", "2026-09-10T21:34:56+09:00"]) {
				timestamp = value;
				await show();
				expect(area.innerHTML).toBe(legacy);
				expect(area.innerHTML).not.toContain("time_NaN");
			}
		}
	} finally {
		request.mockRestore();
		clearHistoryState();
		for (const [key, descriptor] of [
			["document", originalDocument],
			["window", originalWindow],
		] as const) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
