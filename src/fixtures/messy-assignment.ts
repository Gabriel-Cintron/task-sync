import { externalItemFingerprint } from "../core/hash.js";
import { ExternalItemSchema, type ExternalItem } from "../core/models.js";

const base = {
  ref: { sourceType: "fixture", connectionId: "synthetic-school", externalId: "chem-42" },
  kind: "assignment" as const,
  course: { externalId: "chemistry-101", name: "Chemistry I - Period 3 - Fall" },
  title: "*** READ THIS *** LAB REPORT #4!!!!",
  description: "Submit one PDF. Include observations and the reaction table. This is the real assignment; do not make study subtasks.",
  dueAt: "2026-10-03T20:00:00.000-04:00",
  duePrecision: "datetime" as const,
  sourceUrl: "https://example.invalid/courses/chemistry/assignments/42",
  status: "open" as const,
  sourceUpdatedAt: "2026-09-18T15:00:00.000Z",
};

export const messyAssignmentFixture: ExternalItem = ExternalItemSchema.parse({
  ...base,
  rawFingerprint: externalItemFingerprint(base),
});
