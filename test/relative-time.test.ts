import { describe, expect, test } from "bun:test";
import { formatRelativeTime } from "../src/lib/relative-time";

describe("formatRelativeTime", () => {
	test("describes current, past, and future timestamps in Japanese", () => {
		const now = Date.UTC(2026, 7, 22, 12);

		expect(formatRelativeTime(now, now)).toBe("今");
		expect(formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000, now)).toBe("3日前");
		expect(formatRelativeTime(now - 90 * 24 * 60 * 60 * 1000, now)).toBe("90日前");
		expect(formatRelativeTime(now + 2 * 24 * 60 * 60 * 1000, now)).toBe("明後日");
	});
});
