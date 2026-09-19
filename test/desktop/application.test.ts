import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskSyncApplication, type ApplicationFactories } from "../../src/application/task-sync-application.js";
import { desktopPaths, SettingsStore } from "../../src/application/settings-store.js";
import { externalItemFingerprint } from "../../src/core/hash.js";
import type { EnrichmentResult, ExternalItem, TaskEnrichment } from "../../src/core/models.js";
import type { DiagnosticReport } from "../../src/core/ports.js";
import { SqliteSyncRepository } from "../../src/persistence/sqlite-repository.js";
import { FakeSource, FakeTodoist, testConfig } from "../helpers.js";

function assignment(): ExternalItem {
  const input = {
    ref: { sourceType: "canvas", connectionId: "canvas", externalId: "assignment-1" },
    kind: "assignment" as const,
    course: { externalId: "course-1", name: "Biology" },
    title: "Cell lab",
    description: "Complete the lab notes",
    dueAt: "2026-10-05T20:00:00.000Z",
    duePrecision: "datetime" as const,
    sourceUrl: "https://canvas.example.edu/assignments/1",
    status: "open" as const,
  };
  return { ...input, rawFingerprint: externalItemFingerprint(input) };
}

const enrichment: TaskEnrichment = {
  isActionable: true,
  cleanedTitle: "Cell lab",
  conciseDescription: "Complete the lab notes",
  suggestedProjectKey: "inbox",
  suggestedLabels: ["school"],
  confidence: 0.95,
  warnings: [],
};

function successfulDiagnostic(provider: string): Promise<DiagnosticReport> {
  return Promise.resolve({ provider, ok: true, checks: [{ name: "connection", ok: true, detail: "Connected" }] });
}

function fixture(): { application: TaskSyncApplication; todoist: FakeTodoist; store: SettingsStore } {
  const root = mkdtempSync(join(tmpdir(), "task-sync-app-"));
  const store = new SettingsStore(desktopPaths(root));
  store.save({ credentials: { todoistApiToken: "todo", canvasBaseUrl: "https://canvas.example.edu", canvasAccessToken: "canvas" }, config: testConfig() });
  const todoist = Object.assign(new FakeTodoist(), {
    listDestinations: async () => ({ projects: [{ id: "project-1", name: "School" }], sections: [] }),
  });
  const source = new FakeSource([assignment()]);
  Object.defineProperties(source, { sourceType: { value: "canvas" }, connectionId: { value: "canvas" } });
  const canvas = Object.assign(source, { listCourses: async () => [{ externalId: "course-1", name: "Biology" }] });
  const result: EnrichmentResult = {
    enrichment,
    provenance: { model: "fake", promptVersion: "1", schemaVersion: "1", inputFingerprint: "fingerprint", createdAt: new Date().toISOString(), status: "processed", warnings: [] },
  };
  const factories: ApplicationFactories = {
    repository: (path) => new SqliteSyncRepository(path),
    todoist: () => todoist,
    canvas: () => canvas,
    classroom: () => ({ sourceType: "google_classroom", connectionId: "classroom", listItems: async () => [], diagnose: () => successfulDiagnostic("Google Classroom"), authorize: async () => undefined }),
    sources: () => [canvas],
    enrichment: () => ({ enrich: async () => result }),
    openAI: () => ({ generate: async () => enrichment }),
  };
  return { application: new TaskSyncApplication(store, factories, "desktop"), todoist, store };
}

describe("shared application service", () => {
  it("previews without writes, applies the exact saved plan once, and records desktop history", async () => {
    const { application, todoist } = fixture();
    const view = await application.createPlan({ source: "canvas", forceReenrich: false });
    expect(view.counts).toMatchObject({ create: 1 });
    expect(todoist.creates).toBe(0);

    await expect(application.applyPlan({ planId: view.plan.id, digest: "0".repeat(64) })).rejects.toThrow("digest");
    const result = await application.applyPlan({ planId: view.plan.id, digest: view.digest });
    expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "create" })]);
    expect(todoist.creates).toBe(1);
    await expect(application.applyPlan({ planId: view.plan.id, digest: view.digest })).rejects.toThrow("status is applied");

    const runs = await application.listRecentRuns(20);
    expect(runs.map((run) => run.mode)).toEqual(["apply", "plan"]);
    expect(runs.every((run) => run.origin === "desktop")).toBe(true);
  });

  it("invalidates a plan when configuration changes after preview", async () => {
    const { application, store } = fixture();
    const view = await application.createPlan({ source: "canvas", forceReenrich: false });
    const changed = store.config(); changed.enrichment.mappingConfidence = 0.55;
    await application.saveSetup({ config: changed });
    await expect(application.applyPlan({ planId: view.plan.id, digest: view.digest })).rejects.toThrow("Settings changed");
  });

  it("discovers courses and destinations through provider adapters", async () => {
    const { application } = fixture();
    await expect(application.discoverCanvasCourses()).resolves.toEqual([{ externalId: "course-1", name: "Biology" }]);
    await expect(application.listTodoistDestinations()).resolves.toEqual({ projects: [{ id: "project-1", name: "School" }], sections: [] });
  });
});
