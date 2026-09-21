import { describe, expect, it, vi } from "vitest";
import { externalItemFingerprint } from "../src/core/hash.js";
import type { ExternalItem, TaskEnrichment } from "../src/core/models.js";
import { CachedEnrichmentService, type EnrichmentGenerator } from "../src/enrichment/service.js";
import { SqliteSyncRepository } from "../src/persistence/sqlite-repository.js";
import { SyncEngine } from "../src/sync/engine.js";
import { stableMarker } from "../src/sync/policy.js";
import { FakeSource, FakeTodoist, testConfig } from "./helpers.js";

function item(overrides: Partial<ExternalItem> = {}): ExternalItem {
  const base = {
    ref: { sourceType: "fake", connectionId: "account-1", externalId: "a1" },
    kind: "assignment" as const,
    course: { externalId: "c1", name: "Math" },
    title: "Homework 1",
    description: "Problems 1-10",
    dueAt: "2026-10-01T21:00:00.000Z",
    duePrecision: "datetime" as const,
    sourceUrl: "https://school.example/a1",
    status: "open" as const,
  };
  const combined = { ...base, ...overrides };
  return { ...combined, rawFingerprint: externalItemFingerprint(combined) };
}

const enrichment: TaskEnrichment = {
  isActionable: true,
  cleanedTitle: "Homework 1",
  conciseDescription: "Problems 1-10",
  suggestedProjectKey: "math",
  suggestedLabels: ["school"],
  confidence: 0.95,
  warnings: [],
};

describe("sync engine end to end with fakes", () => {
  it("plans dry-run without writes, applies once, then deduplicates and reuses cache", async () => {
    const repository = new SqliteSyncRepository(":memory:");
    const todoist = new FakeTodoist();
    const generate = vi.fn(async () => enrichment);
    const service = new CachedEnrichmentService(repository, { generate } satisfies EnrichmentGenerator, testConfig());
    const engine = new SyncEngine(repository, service, todoist, testConfig());
    const source = new FakeSource([item()]);

    const first = await engine.plan([source]);
    expect(first.actions[0]?.kind).toBe("create");
    expect(todoist.creates).toBe(0);
    await engine.apply(first);
    expect(todoist.creates).toBe(1);

    const second = await engine.plan([source]);
    expect(second.actions[0]?.kind).toBe("unchanged");
    expect(todoist.creates).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("updates exactly once when the authoritative deadline changes", async () => {
    const repository = new SqliteSyncRepository(":memory:");
    const todoist = new FakeTodoist();
    const service = new CachedEnrichmentService(repository, { generate: async () => enrichment }, testConfig());
    const engine = new SyncEngine(repository, service, todoist, testConfig());
    const source = new FakeSource([item()]);
    await engine.apply(await engine.plan([source]));
    source.items = [item({ dueAt: "2026-10-02T21:00:00.000Z" })];
    const changed = await engine.plan([source]);
    expect(changed.actions[0]?.kind).toBe("update");
    await engine.apply(changed);
    expect(todoist.updates).toBe(1);
    expect(todoist.creates).toBe(1);
    repository.close();
  });

  it("recovers one marker but reports duplicate markers as conflicts", async () => {
    const repository = new SqliteSyncRepository(":memory:");
    const todoist = new FakeTodoist();
    const sourceItem = item();
    const marker = stableMarker(sourceItem);
    todoist.tasks.set("old-1", { id: "old-1", content: "Existing", description: `<!-- ${marker} -->`, labels: [] });
    const engine = new SyncEngine(repository, new CachedEnrichmentService(repository, { generate: async () => enrichment }, testConfig()), todoist, testConfig());
    const recovered = await engine.plan([new FakeSource([sourceItem])]);
    expect(recovered.actions[0]).toMatchObject({ kind: "update", todoistTaskId: "old-1" });

    const secondRepository = new SqliteSyncRepository(":memory:");
    todoist.tasks.set("old-2", { id: "old-2", content: "Duplicate", description: `<!-- ${marker} -->`, labels: [] });
    const conflictEngine = new SyncEngine(secondRepository, new CachedEnrichmentService(secondRepository, { generate: async () => enrichment }, testConfig()), todoist, testConfig());
    const conflict = await conflictEngine.plan([new FakeSource([sourceItem])]);
    expect(conflict.actions[0]?.kind).toBe("conflict");
    repository.close();
    secondRepository.close();
  });

  it("recovers Classroom tasks created with the legacy course-work-only marker", async () => {
    const repository = new SqliteSyncRepository(":memory:");
    const todoist = new FakeTodoist();
    const classroomItem = item({
      ref: { sourceType: "google_classroom", connectionId: "school-google", externalId: "course-1:work-2" },
      providerMetadata: { legacyExternalId: "work-2" },
    });
    const legacyMarker = stableMarker({ ...classroomItem, ref: { ...classroomItem.ref, externalId: "work-2" } });
    todoist.tasks.set("legacy", { id: "legacy", content: "Existing", description: `<!-- ${legacyMarker} -->`, labels: [] });
    const engine = new SyncEngine(repository, new CachedEnrichmentService(repository, { generate: async () => enrichment }, testConfig()), todoist, testConfig());
    const plan = await engine.plan([new FakeSource([classroomItem])]);
    expect(plan.actions[0]).toMatchObject({ kind: "update", todoistTaskId: "legacy" });
    repository.close();
  });

  it("skips completed items and never deletes tasks for missing items", async () => {
    const repository = new SqliteSyncRepository(":memory:");
    const todoist = new FakeTodoist();
    const engine = new SyncEngine(repository, new CachedEnrichmentService(repository, { generate: async () => enrichment }, testConfig()), todoist, testConfig());
    const skipped = await engine.plan([new FakeSource([item({ status: "completed" })])]);
    expect(skipped.actions[0]?.kind).toBe("skip");
    const missing = await engine.plan([new FakeSource([])]);
    expect(missing.actions).toHaveLength(0);
    expect(todoist.deletes).toBe(0);
    repository.close();
  });
});
