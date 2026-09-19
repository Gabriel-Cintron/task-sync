import { z } from "zod";
import { classifyHttpFailure } from "../core/errors.js";
import type { DiagnosticReport, TodoistDestination } from "../core/ports.js";
import type { TodoistTask, TodoistTaskInput } from "../core/models.js";

const TodoistTaskSchema = z.object({
  id: z.string(),
  content: z.string(),
  description: z.string().default(""),
  project_id: z.string().nullish(),
  section_id: z.string().nullish(),
  labels: z.array(z.string()).default([]),
  deadline: z.object({ date: z.string() }).nullish(),
}).passthrough();

const PaginatedTasksSchema = z.object({
  results: z.array(TodoistTaskSchema),
  next_cursor: z.string().nullish(),
}).passthrough();

const NamedResourcePageSchema = z.object({
  results: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
  next_cursor: z.string().nullish(),
}).passthrough();

function normalize(raw: z.infer<typeof TodoistTaskSchema>): TodoistTask {
  return {
    id: raw.id,
    content: raw.content,
    description: raw.description,
    ...(raw.project_id ? { projectId: raw.project_id } : {}),
    ...(raw.section_id ? { sectionId: raw.section_id } : {}),
    labels: raw.labels,
    ...(raw.deadline?.date ? { deadlineAt: `${raw.deadline.date}T23:59:59.000Z` } : {}),
  };
}

export class TodoistAdapter implements TodoistDestination {
  public constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.todoist.com/api/v1",
  ) {}

  public async getTask(id: string): Promise<TodoistTask | undefined> {
    const response = await this.request(`/tasks/${encodeURIComponent(id)}`, { method: "GET" }, true);
    if (!response) return undefined;
    return normalize(TodoistTaskSchema.parse(await response.json()));
  }

  public async findByStableMarker(marker: string): Promise<TodoistTask[]> {
    const matches: TodoistTask[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request(`/tasks?${query.toString()}`, { method: "GET" });
      const page = PaginatedTasksSchema.parse(await response!.json());
      matches.push(...page.results.filter((task) => task.description.includes(marker)).map(normalize));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return matches;
  }

  public async createTask(input: TodoistTaskInput, requestId: string): Promise<TodoistTask> {
    const response = await this.request("/tasks", {
      method: "POST",
      headers: { "X-Request-Id": requestId },
      body: JSON.stringify(this.payload(input, true)),
    });
    return normalize(TodoistTaskSchema.parse(await response!.json()));
  }

  public async updateTask(id: string, input: TodoistTaskInput, requestId: string): Promise<TodoistTask> {
    const current = await this.getTask(id);
    if (!current) throw new Error(`Todoist task ${id} no longer exists`);
    let response = await this.request(`/tasks/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "X-Request-Id": requestId },
      body: JSON.stringify(this.payload(input, false)),
    });
    let updated = normalize(TodoistTaskSchema.parse(await response!.json()));
    const destinationChanged = current.projectId !== input.projectId || current.sectionId !== input.sectionId;
    if (destinationChanged && (input.sectionId || input.projectId)) {
      response = await this.request(`/tasks/${encodeURIComponent(id)}/move`, {
        method: "POST",
        headers: { "X-Request-Id": requestId },
        body: JSON.stringify(input.sectionId ? { section_id: input.sectionId } : { project_id: input.projectId }),
      });
      updated = normalize(TodoistTaskSchema.parse(await response!.json()));
    }
    return updated;
  }

  public async diagnose(options: { mutate?: boolean } = {}): Promise<DiagnosticReport> {
    const projects = await this.countResources("/projects");
    const sections = await this.countResources("/sections");
    const checks: DiagnosticReport["checks"] = [
      { name: "authentication", ok: true, detail: "Todoist token accepted" },
      { name: "projects", ok: true, detail: `${projects} project(s) visible` },
      { name: "sections", ok: true, detail: `${sections} section(s) visible` },
    ];
    if (options.mutate) {
      const suffix = new Date().toISOString();
      const created = await this.createTask({ content: `[task-sync compatibility test] ${suffix}`, description: "Safe to delete", labels: [] }, crypto.randomUUID());
      const retrieved = await this.getTask(created.id);
      await this.updateTask(created.id, { content: `[task-sync compatibility test updated] ${suffix}`, description: "Safe to delete", labels: [] }, crypto.randomUUID());
      await this.request(`/tasks/${encodeURIComponent(created.id)}`, { method: "DELETE" });
      checks.push({ name: "write lifecycle", ok: Boolean(retrieved), detail: "Created, retrieved, updated, and deleted a labeled test task" });
    }
    return { provider: "Todoist", ok: true, checks };
  }

  private payload(input: TodoistTaskInput, includeDestination: boolean): Record<string, unknown> {
    return {
      content: input.content,
      description: input.description,
      labels: input.labels,
      ...(includeDestination && input.projectId ? { project_id: input.projectId } : {}),
      ...(includeDestination && input.sectionId ? { section_id: input.sectionId } : {}),
      deadline_date: input.deadlineAt ? input.deadlineAt.slice(0, 10) : null,
    };
  }

  private async countResources(path: string): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request(`${path}?${query.toString()}`, { method: "GET" });
      const page = NamedResourcePageSchema.parse(await response!.json());
      count += page.results.length;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return count;
  }

  private async request(path: string, init: RequestInit, allowNotFound = false): Promise<Response | undefined> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok) throw classifyHttpFailure("Todoist", response.status, await response.text());
    return response;
  }
}
