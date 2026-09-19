import { z } from "zod";
import { classifyHttpFailure, ProviderError } from "../core/errors.js";
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../core/fetch-with-timeout.js";
import { externalItemFingerprint } from "../core/hash.js";
import { ExternalItemSchema, type ExternalItem } from "../core/models.js";
import type { DiagnosticReport, SourceAdapter } from "../core/ports.js";

const CanvasCourseSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  workflow_state: z.string().optional(),
}).passthrough();

const CanvasAssignmentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  description: z.string().nullish(),
  due_at: z.string().datetime({ offset: true }).nullish(),
  html_url: z.string().url().nullish(),
  updated_at: z.string().datetime({ offset: true }).nullish(),
  points_possible: z.number().nullish(),
  submission_types: z.array(z.string()).optional(),
  submission: z.object({
    workflow_state: z.string().optional(),
    submitted_at: z.string().nullish(),
  }).passthrough().nullish(),
}).passthrough();

const CanvasProfileSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().optional(),
}).passthrough();

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const segment of header.split(",")) {
    const match = segment.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1];
  }
  return undefined;
}

function canvasStatus(submission: z.infer<typeof CanvasAssignmentSchema>["submission"]): ExternalItem["status"] {
  if (!submission) return "unknown";
  if (submission.workflow_state === "graded") return "completed";
  if (submission.workflow_state === "submitted" || submission.submitted_at) return "submitted";
  if (submission.workflow_state === "unsubmitted") return "open";
  return "unknown";
}

export function normalizeCanvasAssignment(courseInput: unknown, assignmentInput: unknown, connectionId: string): ExternalItem {
  const course = CanvasCourseSchema.parse(courseInput);
  const raw = CanvasAssignmentSchema.parse(assignmentInput);
  const courseId = String(course.id);
  const base = {
    ref: { sourceType: "canvas", connectionId, externalId: String(raw.id) },
    kind: "assignment" as const,
    course: { externalId: courseId, name: course.name },
    title: raw.name,
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.due_at ? { dueAt: raw.due_at, duePrecision: "datetime" as const } : {}),
    ...(raw.html_url ? { sourceUrl: raw.html_url } : {}),
    status: canvasStatus(raw.submission),
    ...(raw.updated_at ? { sourceUpdatedAt: raw.updated_at } : {}),
    providerMetadata: {
      canvasWorkflowState: raw.submission?.workflow_state ?? null,
      submittedAt: raw.submission?.submitted_at ?? null,
      pointsPossible: raw.points_possible ?? null,
      submissionTypes: raw.submission_types ?? [],
    },
  };
  return ExternalItemSchema.parse({ ...base, rawFingerprint: externalItemFingerprint(base) });
}

export class CanvasAdapter implements SourceAdapter {
  public readonly sourceType = "canvas";

  public constructor(
    public readonly connectionId: string,
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly excludedCourseIds?: ReadonlySet<string>,
    private readonly includeUndatedAssignments = true,
    private readonly requestTimeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  ) {
    if (!baseUrl.startsWith("https://")) throw new ProviderError("configuration", "CANVAS_BASE_URL must use HTTPS");
  }

  public async listItems(options: { signal?: AbortSignal } = {}): Promise<ExternalItem[]> {
    const discoveredCourses = await this.listCourses(options);
    const courses = this.excludedCourseIds
      ? discoveredCourses.filter((course) => !this.excludedCourseIds!.has(course.externalId))
      : discoveredCourses;
    const items: ExternalItem[] = [];
    for (const course of courses) {
      const courseId = course.externalId;
      const assignments = await this.getAll(
        `/api/v1/courses/${encodeURIComponent(courseId)}/assignments?include[]=submission&per_page=100`,
        CanvasAssignmentSchema,
        options.signal,
      );
      for (const raw of assignments) {
        const item = normalizeCanvasAssignment({ id: course.externalId, name: course.name }, raw, this.connectionId);
        if (this.includeUndatedAssignments || item.dueAt) items.push(item);
      }
    }
    return items;
  }

  public async listCourses(options: { signal?: AbortSignal } = {}): Promise<Array<{ externalId: string; name: string }>> {
    const courses = await this.getAll("/api/v1/courses?enrollment_state=active&state[]=available&per_page=100", CanvasCourseSchema, options.signal);
    return courses.map((course) => ({ externalId: String(course.id), name: course.name }));
  }

  public async diagnose(): Promise<DiagnosticReport> {
    const profile = CanvasProfileSchema.parse(await this.requestJson(new URL("/api/v1/users/self/profile", this.baseUrl).toString()));
    const courses = await this.getAll("/api/v1/courses?enrollment_state=active&state[]=available&per_page=100", CanvasCourseSchema);
    let assignmentCount = 0;
    let fieldCount = 0;
    for (const course of courses.slice(0, 5)) {
      const assignments = await this.getAll(`/api/v1/courses/${String(course.id)}/assignments?include[]=submission&per_page=10`, CanvasAssignmentSchema);
      assignmentCount += assignments.length;
      fieldCount += assignments.filter((item) => item.html_url || item.due_at).length;
    }
    return {
      provider: "Canvas",
      ok: true,
      checks: [
        { name: "authentication", ok: true, detail: `Authenticated profile ${String(profile.id)}` },
        { name: "active courses", ok: true, detail: `${courses.length} active course(s) visible` },
        { name: "assignments", ok: true, detail: `${assignmentCount} sampled; ${fieldCount} include a due date or URL` },
      ],
    };
  }

  private async getAll<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T[]> {
    const results: T[] = [];
    let url: string | undefined = new URL(path, this.baseUrl).toString();
    while (url) {
      const response = await this.request(url, signal);
      results.push(...z.array(schema).parse(await response.json()));
      url = nextLink(response.headers.get("link"));
    }
    return results;
  }

  private async requestJson(url: string): Promise<unknown> {
    return (await this.request(url)).json() as Promise<unknown>;
  }

  private async request(url: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetchWithTimeout(
      "Canvas",
      this.fetchImpl,
      url,
      { headers: { Authorization: `Bearer ${this.token}` }, ...(signal ? { signal } : {}) },
      this.requestTimeoutMs,
    );
    if (!response.ok) throw classifyHttpFailure("Canvas", response.status, await response.text());
    return response;
  }
}
