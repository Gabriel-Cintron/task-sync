import { appendFileSync } from "node:fs";
import type { AppConfig } from "../config.js";
import { externalItemFingerprint } from "../core/hash.js";
import type { EnrichmentResult, ExternalItem, TaskEnrichment, TodoistTask, TodoistTaskInput } from "../core/models.js";
import type { DiagnosticReport, EnrichmentService, SourceAdapter, SyncRepository } from "../core/ports.js";
import type { ApplicationFactories } from "../application/task-sync-application.js";
import { SqliteSyncRepository } from "../persistence/sqlite-repository.js";

function report(provider: string): Promise<DiagnosticReport> {
  return Promise.resolve({ provider, ok: true, checks: [{ name: "connection", ok: true, detail: "Connected to the local smoke-test provider" }] });
}

function item(id: string, title: string): ExternalItem {
  const value = {
    ref: { sourceType: "canvas", connectionId: "canvas", externalId: id },
    kind: "assignment" as const,
    course: { externalId: "course-biology", name: "Biology" }, title,
    description: "Read the instructions and submit your work.", dueAt: "2026-10-15T20:00:00.000Z", duePrecision: "datetime" as const,
    sourceUrl: `https://canvas.example.edu/assignments/${id}`, status: "open" as const,
  };
  return { ...value, rawFingerprint: externalItemFingerprint(value) };
}

class SmokeCanvas implements SourceAdapter {
  public readonly sourceType = "canvas";
  public readonly connectionId = "canvas";
  public async listCourses(): Promise<Array<{ externalId: string; name: string }>> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return [{ externalId: "course-biology", name: "Biology" }];
  }
  public listItems(): Promise<ExternalItem[]> { return Promise.resolve([item("safe-create", "Cell lab"), item("duplicate-conflict", "Research notes"), item("enrichment-error", "Broken row")]); }
  public diagnose(): Promise<DiagnosticReport> { return report("Canvas"); }
}

class SmokeTodoist {
  public readonly tasks = new Map<string, TodoistTask>();
  private markerLookups = 0;
  private nextId = 1;
  public constructor(private readonly writeLog?: string) {}
  public diagnose(): Promise<DiagnosticReport> { return report("Todoist"); }
  public listDestinations(): Promise<{ projects: Array<{ id: string; name: string }>; sections: [] }> { return Promise.resolve({ projects: [{ id: "school", name: "School" }], sections: [] }); }
  public getTask(id: string): Promise<TodoistTask | undefined> { return Promise.resolve(this.tasks.get(id)); }
  public findByStableMarker(): Promise<TodoistTask[]> {
    this.markerLookups += 1;
    if (this.markerLookups === 2) return Promise.resolve([
      { id: "duplicate-1", content: "Duplicate one", description: "", labels: [] },
      { id: "duplicate-2", content: "Duplicate two", description: "", labels: [] },
    ]);
    return Promise.resolve([]);
  }
  public createTask(input: TodoistTaskInput): Promise<TodoistTask> {
    if (this.writeLog) appendFileSync(this.writeLog, "create\n", "utf8");
    const task = { id: `created-${this.nextId++}`, ...input }; this.tasks.set(task.id, task); return Promise.resolve(task);
  }
  public updateTask(id: string, input: TodoistTaskInput): Promise<TodoistTask> {
    if (this.writeLog) appendFileSync(this.writeLog, "update\n", "utf8");
    const task = { id, ...input }; this.tasks.set(id, task); return Promise.resolve(task);
  }
}

function enrichment(): EnrichmentService {
  return {
    enrich: (source): Promise<EnrichmentResult> => {
      if (source.ref.externalId === "enrichment-error") return Promise.reject(new Error("Synthetic enrichment failure"));
      const value: TaskEnrichment = { isActionable: true, cleanedTitle: source.title, conciseDescription: source.description, suggestedProjectKey: "inbox", suggestedLabels: [], confidence: 1, warnings: [] };
      return Promise.resolve({ enrichment: value, provenance: { model: "smoke", promptVersion: "1", schemaVersion: "1", inputFingerprint: source.rawFingerprint, createdAt: new Date().toISOString(), status: "processed", warnings: [] } });
    },
  };
}

export function createSmokeFactories(): ApplicationFactories {
  const canvas = new SmokeCanvas();
  const todoist = new SmokeTodoist(process.env.TASK_SYNC_E2E_WRITE_LOG);
  return {
    repository: (path: string): SyncRepository => new SqliteSyncRepository(path),
    todoist: () => todoist,
    canvas: () => canvas,
    classroom: () => ({ sourceType: "google_classroom", connectionId: "classroom", listItems: () => Promise.resolve([]), diagnose: () => report("Google Classroom"), authorize: () => Promise.resolve() }),
    sources: (_config: AppConfig, selection) => selection === "classroom" ? [] : [canvas],
    enrichment: () => enrichment(),
    openAI: () => ({ generate: (source) => Promise.resolve({ isActionable: true, cleanedTitle: source.title, suggestedLabels: [], confidence: 1, warnings: [] }) }),
  };
}
