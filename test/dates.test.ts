import { describe, expect, it } from "vitest";
import { defaultDateRange, pacificToday, shiftDate } from "../src/dates.js";

describe("dates", () => {
  it("shifts across month and year boundaries", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2025-12-31", 1)).toBe("2026-01-01");
    expect(shiftDate("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("uses the Pacific calendar day", () => {
    expect(pacificToday(new Date("2026-10-08T05:00:00Z"))).toBe("2026-10-07");
    expect(pacificToday(new Date("2026-10-08T12:00:00Z"))).toBe("2026-10-08");
    expect(pacificToday(new Date("2026-01-15T07:30:00Z"))).toBe("2026-01-14");
  });

  it("defaults to 28 days ending three days ago", () => {
    expect(defaultDateRange(new Date("2026-10-08T12:00:00Z"))).toEqual({
      start: "2026-09-08",
      end: "2026-10-05",
    });
  });
});
