import { describe, expect, it } from "vitest";
import { todoistTaskFingerprint } from "../src/core/hash.js";

describe("destination fingerprints", () => {
  const base = { id: "1", content: "Assignment", description: "Details", labels: [] };

  it("preserves due time while treating equivalent timezone representations equally", () => {
    const afternoon = todoistTaskFingerprint({ ...base, deadlineAt: "2026-10-03T20:00:00-04:00", deadlinePrecision: "datetime", dateKind: "due" });
    const sameInstant = todoistTaskFingerprint({ ...base, deadlineAt: "2026-10-04T00:00:00.000Z", deadlinePrecision: "datetime", dateKind: "due" });
    const later = todoistTaskFingerprint({ ...base, deadlineAt: "2026-10-04T01:00:00.000Z", deadlinePrecision: "datetime", dateKind: "due" });
    expect(afternoon).toBe(sameInstant);
    expect(later).not.toBe(afternoon);
  });

  it("uses only the calendar date for date-only deadlines", () => {
    const first = todoistTaskFingerprint({ ...base, deadlineAt: "2026-10-03T23:59:59.000Z", deadlinePrecision: "date", dateKind: "due" });
    const second = todoistTaskFingerprint({ ...base, deadlineAt: "2026-10-03T12:00:00.000Z", deadlinePrecision: "date", dateKind: "due" });
    expect(first).toBe(second);
  });
});
