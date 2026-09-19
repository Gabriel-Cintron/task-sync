import { describe, expect, it, vi } from "vitest";
import { OpenAIEnrichmentSchema } from "../src/core/models.js";
import { CachedEnrichmentService, PROMPT_VERSION, SCHEMA_VERSION, type EnrichmentGenerator } from "../src/enrichment/service.js";
import { messyAssignmentFixture } from "../src/fixtures/messy-assignment.js";
import { SqliteSyncRepository } from "../src/persistence/sqlite-repository.js";
import { testConfig } from "./helpers.js";

const valid = {
  isActionable: true,
  cleanedTitle: "Lab Report 4",
  conciseDescription: "Submit one PDF.",
  suggestedProjectKey: "math",
  suggestedLabels: ["school", "not-allowed"],
  inferredDueAt: "2026-10-05T10:00:00.000Z",
  confidence: 0.9,
  warnings: [],
};

describe("enrichment", () => {
  it("strictly validates structured output", () => {
    expect(OpenAIEnrichmentSchema.parse({ ...valid, conciseDescription: null, suggestedProjectKey: null, inferredDueAt: null })).toBeTruthy();
    expect(() => OpenAIEnrichmentSchema.parse({ ...valid, confidence: 2, extra: true })).toThrow();
  });

  it("versions and caches enrichments while enforcing allowlists", async () => {
    const repository = new SqliteSyncRepository(":memory:");
    const generate = vi.fn(async () => valid);
    const generator: EnrichmentGenerator = { generate };
    const service = new CachedEnrichmentService(repository, generator, testConfig());
    const first = await service.enrich(messyAssignmentFixture);
    const second = await service.enrich(messyAssignmentFixture);
    expect(first.provenance.promptVersion).toBe(PROMPT_VERSION);
    expect(first.provenance.schemaVersion).toBe(SCHEMA_VERSION);
    expect(first.enrichment.suggestedLabels).toEqual(["school"]);
    expect(second.provenance.status).toBe("cached");
    expect(generate).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("falls back safely on refusal, timeout, or invalid output", async () => {
    const repository = new SqliteSyncRepository(":memory:");
    const generator: EnrichmentGenerator = { generate: async () => { throw new Error("request timed out"); } };
    const result = await new CachedEnrichmentService(repository, generator, testConfig()).enrich(messyAssignmentFixture);
    expect(result.provenance.status).toBe("fallback");
    expect(result.enrichment.cleanedTitle).toBe(messyAssignmentFixture.title);
    expect(result.enrichment.warnings[0]).toContain("fallback used");
    repository.close();
  });

  it("fails closed when enrichment is required", async () => {
    const repository = new SqliteSyncRepository(":memory:");
    const config = testConfig({ enrichment: { ...testConfig().enrichment, mode: "required" } });
    const service = new CachedEnrichmentService(repository, undefined, config);
    await expect(service.enrich(messyAssignmentFixture)).rejects.toThrow("required");
    repository.close();
  });
});
