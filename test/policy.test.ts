import { describe, expect, it } from "vitest";
import type { TaskEnrichment } from "../src/core/models.js";
import { messyAssignmentFixture } from "../src/fixtures/messy-assignment.js";
import { buildCandidate, resolveMapping } from "../src/sync/policy.js";
import { testConfig } from "./helpers.js";

const enrichment: TaskEnrichment = {
  isActionable: true,
  cleanedTitle: "Clean title",
  conciseDescription: "Useful details",
  suggestedProjectKey: "math",
  suggestedLabels: ["school"],
  inferredDueAt: "2030-01-01T00:00:00.000Z",
  confidence: 0.95,
  warnings: [],
};

describe("deterministic candidate policy", () => {
  it("never lets an inferred deadline override the source", () => {
    const candidate = buildCandidate(messyAssignmentFixture, enrichment, testConfig());
    expect(candidate.resolvedDeadlineAt).toBe(messyAssignmentFixture.dueAt);
    expect(candidate.deadlineOrigin).toBe("source");
    expect(candidate.warnings.join(" ")).toContain("Ignored inferred deadline");
  });

  it("confidence-gates inferred deadlines", () => {
    const source = { ...messyAssignmentFixture, dueAt: undefined };
    const candidate = buildCandidate(source, { ...enrichment, confidence: 0.5 }, testConfig());
    expect(candidate.resolvedDeadlineAt).toBeUndefined();
    expect(candidate.deadlineOrigin).toBe("none");
  });

  it("uses explicit course IDs before aliases and LLM suggestions", () => {
    const config = testConfig({
      destinations: { inbox: {}, explicit: {}, alias: {}, math: {} },
      courseMappings: [
        { sourceType: "fixture", connectionId: "synthetic-school", courseExternalId: "chemistry-101", destinationKey: "explicit" },
        { courseAlias: "chemistry i", destinationKey: "alias" },
      ],
    });
    expect(resolveMapping(messyAssignmentFixture, enrichment, config).destinationKey).toBe("explicit");
  });
});
