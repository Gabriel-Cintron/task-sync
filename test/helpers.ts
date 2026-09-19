import { AppConfigSchema, type AppConfig } from "../src/config.js";
import type { ExternalItem, TodoistTask, TodoistTaskInput } from "../src/core/models.js";
import type { DiagnosticReport, SourceAdapter, TodoistDestination } from "../src/core/ports.js";

export function testConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return AppConfigSchema.parse({
    databasePath: ":memory:",
    enrichment: {
      mode: "fallback",
      model: "test-model",
      inferredDueConfidence: 0.85,
      mappingConfidence: 0.8,
      maxDescriptionCharacters: 8000,
      allowedLabels: ["school", "math"],
    },
    destinations: { inbox: {}, math: { projectId: "p-math" } },
    defaultDestinationKey: "inbox",
    courseMappings: [],
    sources: {},
    ...overrides,
  });
}

export class FakeSource implements SourceAdapter {
  public readonly sourceType = "fake";
  public readonly connectionId = "account-1";
  public constructor(public items: ExternalItem[]) {}
  public async listItems(): Promise<ExternalItem[]> { return this.items; }
  public async diagnose(): Promise<DiagnosticReport> { return { provider: "Fake", ok: true, checks: [] }; }
}

export class FakeTodoist implements TodoistDestination {
  public tasks = new Map<string, TodoistTask>();
  public creates = 0;
  public updates = 0;
  public deletes = 0;
  private nextId = 1;

  public async diagnose(): Promise<DiagnosticReport> { return { provider: "Fake Todoist", ok: true, checks: [] }; }
  public async getTask(id: string): Promise<TodoistTask | undefined> { return this.tasks.get(id); }
  public async findByStableMarker(marker: string): Promise<TodoistTask[]> {
    return [...this.tasks.values()].filter((task) => task.description.includes(marker));
  }
  public async createTask(input: TodoistTaskInput): Promise<TodoistTask> {
    this.creates += 1;
    const task = { id: String(this.nextId++), ...input };
    this.tasks.set(task.id, task);
    return task;
  }
  public async updateTask(id: string, input: TodoistTaskInput): Promise<TodoistTask> {
    this.updates += 1;
    const task = { id, ...input };
    this.tasks.set(id, task);
    return task;
  }
}
