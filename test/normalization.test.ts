import { describe, expect, it } from "vitest";
import { normalizeCanvasAssignment } from "../src/adapters/canvas.js";
import { normalizeClassroomCourseWork } from "../src/adapters/google-classroom.js";
import { sourceKey } from "../src/core/hash.js";

describe("provider normalization and stable identity", () => {
  it("normalizes Canvas assignments and submission state", () => {
    const item = normalizeCanvasAssignment(
      { id: 12, name: "Biology" },
      {
        id: 99,
        name: "Cell lab",
        description: "Upload the lab",
        due_at: "2026-09-20T21:00:00-04:00",
        html_url: "https://canvas.example/courses/12/assignments/99",
        updated_at: "2026-09-18T10:00:00Z",
        submission: { workflow_state: "submitted" },
      },
      "district-a",
    );
    expect(item.ref).toEqual({ sourceType: "canvas", connectionId: "district-a", externalId: "99" });
    expect(item.status).toBe("submitted");
    expect(item.dueAt).toBe("2026-09-20T21:00:00-04:00");
  });

  it("normalizes Classroom dates as UTC and own submission state", () => {
    const item = normalizeClassroomCourseWork(
      { id: "course-1", name: "English" },
      {
        id: "work-2",
        title: "Essay",
        dueDate: { year: 2026, month: 10, day: 4 },
        dueTime: { hours: 17, minutes: 30 },
        alternateLink: "https://classroom.google.com/c/example/a/example",
        updateTime: "2026-09-19T01:00:00Z",
      },
      { courseWorkId: "work-2", state: "TURNED_IN" },
      "school-google",
    );
    expect(item.ref.externalId).toBe("course-1:work-2");
    expect(item.dueAt).toBe("2026-10-04T17:30:00.000Z");
    expect(item.status).toBe("submitted");
  });

  it("keeps source type and connection in identity", () => {
    expect(sourceKey({ sourceType: "canvas", connectionId: "one", externalId: "42" }))
      .not.toBe(sourceKey({ sourceType: "canvas", connectionId: "two", externalId: "42" }));
    expect(sourceKey({ sourceType: "canvas", connectionId: "one", externalId: "42" }))
      .not.toBe(sourceKey({ sourceType: "google_classroom", connectionId: "one", externalId: "42" }));
  });
});
