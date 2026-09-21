import { z } from "zod";
import { createHash } from "node:crypto";
import { classifyHttpFailure } from "../core/errors.js";
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../core/fetch-with-timeout.js";
import type { DiagnosticReport, TodoistDestination } from "../core/ports.js";
import type { TodoistTask, TodoistTaskInput } from "../core/models.js";
import type { DestinationCatalog, DestinationProject, DestinationSection } from "../application/contracts.js";

const TodoistTaskSchema = z.object({
  id: z.string(),
  content: z.string(),
  description: z.string().default(""),
  project_id: z.string().nullish(),
  section_id: z.string().nullish(),
  labels: z.array(z.string()).default([]),
  due: z.object({ date: z.string(), datetime: z.string().nullish() }).nullish(),
  deadline: z.object({ date: z.string() }).nullish(),
}).passthrough();

const PaginatedTasksSchema = z.object({
  results: z.array(TodoistTaskSchema),
  next_cursor: z.string().nullish(),
}).passthrough();

const NamedResourcePageSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    name: z.string(),
    project_id: z.string().optional(),
    inbox_project: z.boolean().optional(),
  }).passthrough()),
  next_cursor: z.string().nullish(),
}).passthrough();

type NamedResource = z.infer<typeof NamedResourcePageSchema>["results"][number];

function normalize(raw: z.infer<typeof TodoistTaskSchema>, inboxProjectId?: string): TodoistTask {
  const dueAt = raw.due?.datetime ?? (raw.due?.date ? `${raw.due.date}T23:59:59.000Z` : undefined);
  const deadlineAt = dueAt ?? (raw.deadline?.date ? `${raw.deadline.date}T23:59:59.000Z` : undefined);
  return {
    id: raw.id,
    content: raw.content,
    description: raw.description,
    ...(raw.project_id && raw.project_id !== inboxProjectId ? { projectId: raw.project_id } : {}),
    ...(raw.section_id ? { sectionId: raw.section_id } : {}),
    labels: raw.labels,
    ...(deadlineAt ? {
      deadlineAt,
      deadlinePrecision: raw.due?.datetime ? "datetime" as const : "date" as const,
      dateKind: raw.due ? "due" as const : "deadline" as const,
    } : {}),
  };
}

function derivedRequestId(requestId: string, operation: string): string {
  const hex = createHash("sha256").update(`${requestId}:${operation}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class TodoistAdapter implements TodoistDestination {
  private taskCatalog: Promise<TodoistTask[]> | undefined;
  private projectCatalog: Promise<NamedResource[]> | undefined;

  public constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.todoist.com/api/v1",
    private readonly requestTimeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  ) {}

  public async getTask(id: string, options: { signal?: AbortSignal } = {}): Promise<TodoistTask | undefined> {
    const response = await this.request(`/tasks/${encodeURIComponent(id)}`, { method: "GET", ...options }, true);
    if (!response) return undefined;
    return normalize(TodoistTaskSchema.parse(await response.json()), await this.inboxProjectId(options));
  }

  public async findByStableMarker(marker: string, options: { signal?: AbortSignal } = {}): Promise<TodoistTask[]> {
    options.signal?.throwIfAborted();
    if (!this.taskCatalog) {
      this.taskCatalog = this.listAllTasks(options).catch((error: unknown) => {
        this.taskCatalog = undefined;
        throw error;
      });
    }
    return (await this.taskCatalog).filter((task) => task.description.includes(marker));
  }

  private async listAllTasks(options: { signal?: AbortSignal }): Promise<TodoistTask[]> {
    const tasks: TodoistTask[] = [];
    let cursor: string | undefined;
    do {
      options.signal?.throwIfAborted();
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request(`/tasks?${query.toString()}`, { method: "GET", ...options });
      const page = PaginatedTasksSchema.parse(await response!.json());
      tasks.push(...page.results.map((task) => normalize(task)));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return tasks;
  }

  public async createTask(input: TodoistTaskInput, requestId: string): Promise<TodoistTask> {
    const response = await this.request("/tasks", {
      method: "POST",
      headers: { "X-Request-Id": requestId },
      body: JSON.stringify(this.payload(input, true)),
    });
    const raw = TodoistTaskSchema.parse(await response!.json());
    return normalize(raw, input.projectId ? undefined : raw.project_id ?? undefined);
  }

  public async updateTask(id: string, input: TodoistTaskInput, requestId: string): Promise<TodoistTask> {
    const current = await this.getTask(id);
    if (!current) throw new Error(`Todoist task ${id} no longer exists`);
    const inboxProjectId = await this.inboxProjectId();
    const destinationChanged = current.projectId !== input.projectId || current.sectionId !== input.sectionId;
    let destination: { section_id: string } | { project_id: string } | undefined;
    if (destinationChanged) {
      destination = input.sectionId
        ? { section_id: input.sectionId }
        : input.projectId
          ? { project_id: input.projectId }
          : undefined;
      if (!destination) {
        if (!inboxProjectId) throw new Error("Todoist Inbox project could not be identified");
        destination = { project_id: inboxProjectId };
      }
    }
    let response = await this.request(`/tasks/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "X-Request-Id": requestId },
      body: JSON.stringify(this.payload(input, false)),
    });
    let updated = normalize(TodoistTaskSchema.parse(await response!.json()), inboxProjectId);
    if (destination) {
      response = await this.request(`/tasks/${encodeURIComponent(id)}/move`, {
        method: "POST",
        headers: { "X-Request-Id": derivedRequestId(requestId, "move") },
        body: JSON.stringify(destination),
      });
      updated = normalize(TodoistTaskSchema.parse(await response!.json()), inboxProjectId);
    }
    return updated;
  }

  public async diagnose(options: { mutate?: boolean } = {}): Promise<DiagnosticReport> {
    const catalog = await this.listDestinations();
    const checks: DiagnosticReport["checks"] = [
      { name: "authentication", ok: true, detail: "Todoist token accepted" },
      { name: "projects", ok: true, detail: `${catalog.projects.length} project(s) visible` },
      { name: "sections", ok: true, detail: `${catalog.sections.length} section(s) visible` },
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

  public async listDestinations(options: { signal?: AbortSignal } = {}): Promise<DestinationCatalog> {
    const projectRows = await this.listProjects(options);
    const sectionRows = await this.listResources("/sections", options);
    const projects: DestinationProject[] = projectRows.map((value) => ({ id: value.id, name: value.name, ...(value.inbox_project ? { isInbox: true } : {}) }));
    const sections: DestinationSection[] = sectionRows
      .filter((value): value is typeof value & { project_id: string } => Boolean(value.project_id))
      .map((value) => ({ id: value.id, name: value.name, projectId: value.project_id }));
    return { projects, sections };
  }

  private payload(input: TodoistTaskInput, includeDestination: boolean): Record<string, unknown> {
    const due = input.deadlineAt
      ? input.deadlinePrecision === "date"
        ? { due_date: input.deadlineAt.slice(0, 10) }
        : { due_datetime: new Date(input.deadlineAt).toISOString() }
      : { due_date: null };
    return {
      content: input.content,
      description: input.description,
      labels: input.labels,
      ...(includeDestination && input.projectId ? { project_id: input.projectId } : {}),
      ...(includeDestination && input.sectionId ? { section_id: input.sectionId } : {}),
      ...due,
      deadline_date: null,
    };
  }

  private async listProjects(options: { signal?: AbortSignal } = {}): Promise<NamedResource[]> {
    if (!this.projectCatalog) {
      this.projectCatalog = this.listResources("/projects", options).catch((error: unknown) => {
        this.projectCatalog = undefined;
        throw error;
      });
    }
    return this.projectCatalog;
  }

  private async inboxProjectId(options: { signal?: AbortSignal } = {}): Promise<string | undefined> {
    return (await this.listProjects(options)).find((project) => project.inbox_project)?.id;
  }

  private async listResources(path: string, options: { signal?: AbortSignal } = {}): Promise<NamedResource[]> {
    const results: NamedResource[] = [];
    let cursor: string | undefined;
    do {
      options.signal?.throwIfAborted();
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request(`${path}?${query.toString()}`, { method: "GET", ...options });
      const page = NamedResourcePageSchema.parse(await response!.json());
      results.push(...page.results);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return results;
  }

  private async request(path: string, init: RequestInit, allowNotFound = false): Promise<Response | undefined> {
    const response = await fetchWithTimeout(
      "Todoist",
      this.fetchImpl,
      `${this.baseUrl}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      },
      this.requestTimeoutMs,
    );
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok) throw classifyHttpFailure("Todoist", response.status, await response.text());
    return response;
  }
}
