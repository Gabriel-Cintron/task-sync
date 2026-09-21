import { createHash } from "node:crypto";
import type { ExternalItem, SourceRef, TaskCandidate, TodoistTask, TodoistTaskInput } from "./models.js";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function sourceKey(ref: SourceRef): string {
  return `${ref.sourceType}:${encodeURIComponent(ref.connectionId)}:${encodeURIComponent(ref.externalId)}`;
}

export function externalItemFingerprint(item: Omit<ExternalItem, "rawFingerprint">): string {
  return sha256(stableJson(item));
}

export function enrichmentInputFingerprint(item: ExternalItem): string {
  return sha256(stableJson({
    kind: item.kind,
    title: item.title,
    description: item.description ?? null,
    dueAt: item.dueAt ?? null,
    course: item.course ?? null,
  }));
}

export function candidateToTodoistInput(candidate: TaskCandidate): TodoistTaskInput {
  return {
    content: candidate.resolvedTitle,
    description: candidate.resolvedDescription ?? "",
    ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
    ...(candidate.sectionId ? { sectionId: candidate.sectionId } : {}),
    labels: candidate.labels,
    ...(candidate.resolvedDeadlineAt ? {
      deadlineAt: candidate.resolvedDeadlineAt,
      deadlinePrecision: candidate.source.duePrecision ?? "datetime",
      dateKind: "due" as const,
    } : {}),
  };
}

function canonicalDeadline(deadlineAt: string | undefined, precision: "date" | "datetime" | undefined): string | null {
  if (!deadlineAt) return null;
  if (precision === "date") return deadlineAt.slice(0, 10);
  return new Date(deadlineAt).toISOString();
}

export function destinationFingerprint(candidate: TaskCandidate): string {
  const input = candidateToTodoistInput(candidate);
  return sha256(stableJson({
    content: input.content,
    description: input.description,
    projectId: input.projectId ?? null,
    sectionId: input.sectionId ?? null,
    labels: input.labels,
    deadlineAt: canonicalDeadline(input.deadlineAt, input.deadlinePrecision),
    deadlinePrecision: input.deadlinePrecision ?? null,
    dateKind: input.dateKind ?? null,
  }));
}

export function todoistTaskFingerprint(task: TodoistTask): string {
  return sha256(stableJson({
    content: task.content,
    description: task.description,
    projectId: task.projectId ?? null,
    sectionId: task.sectionId ?? null,
    labels: task.labels,
    deadlineAt: canonicalDeadline(task.deadlineAt, task.deadlinePrecision),
    deadlinePrecision: task.deadlinePrecision ?? null,
    dateKind: task.dateKind ?? null,
  }));
}
