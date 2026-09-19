import { z } from "zod";

export const SourceRefSchema = z.object({
  sourceType: z.string().min(1),
  connectionId: z.string().min(1),
  externalId: z.string().min(1),
}).strict();

export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ExternalItemSchema = z.object({
  ref: SourceRefSchema,
  kind: z.enum(["assignment", "announcement", "other"]),
  course: z.object({
    externalId: z.string().min(1),
    name: z.string().min(1),
  }).strict().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  duePrecision: z.enum(["date", "datetime"]).optional(),
  sourceUrl: z.string().url().optional(),
  status: z.enum(["open", "submitted", "completed", "unknown"]).optional(),
  sourceUpdatedAt: z.string().datetime({ offset: true }).optional(),
  rawFingerprint: z.string().min(1),
  providerMetadata: z.record(z.unknown()).optional(),
}).strict();

export type ExternalItem = z.infer<typeof ExternalItemSchema>;

export const TaskEnrichmentSchema = z.object({
  isActionable: z.boolean(),
  cleanedTitle: z.string().min(1),
  conciseDescription: z.string().optional(),
  suggestedProjectKey: z.string().optional(),
  suggestedLabels: z.array(z.string()),
  inferredDueAt: z.string().datetime({ offset: true }).optional(),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()),
}).strict();

export type TaskEnrichment = z.infer<typeof TaskEnrichmentSchema>;

/** Every field is required for OpenAI Structured Outputs; absent values use null. */
export const OpenAIEnrichmentSchema = z.object({
  isActionable: z.boolean(),
  cleanedTitle: z.string().min(1),
  conciseDescription: z.string().nullable(),
  suggestedProjectKey: z.string().nullable(),
  suggestedLabels: z.array(z.string()),
  inferredDueAt: z.string().datetime({ offset: true }).nullable(),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()),
}).strict();

export const TaskCandidateSchema = z.object({
  source: ExternalItemSchema,
  enrichment: TaskEnrichmentSchema,
  resolvedTitle: z.string().min(1),
  resolvedDescription: z.string().optional(),
  resolvedDeadlineAt: z.string().datetime({ offset: true }).optional(),
  deadlineOrigin: z.enum(["source", "inferred", "none"]),
  destinationKey: z.string(),
  projectId: z.string().optional(),
  sectionId: z.string().optional(),
  labels: z.array(z.string()),
  warnings: z.array(z.string()),
}).strict();

export type TaskCandidate = z.infer<typeof TaskCandidateSchema>;

export type EnrichmentStatus = "processed" | "cached" | "fallback" | "disabled";

export type EnrichmentProvenance = {
  model: string;
  promptVersion: string;
  schemaVersion: string;
  inputFingerprint: string;
  createdAt: string;
  status: EnrichmentStatus;
  warnings: string[];
};

export type EnrichmentResult = {
  enrichment: TaskEnrichment;
  provenance: EnrichmentProvenance;
};

export type TodoistTask = {
  id: string;
  content: string;
  description: string;
  projectId?: string;
  sectionId?: string;
  labels: string[];
  deadlineAt?: string;
};

export type TodoistTaskInput = Omit<TodoistTask, "id">;

export type SyncActionKind = "create" | "update" | "unchanged" | "skip" | "conflict" | "error";

export type SyncAction = {
  kind: SyncActionKind;
  sourceKey: string;
  candidate?: TaskCandidate;
  todoistTaskId?: string;
  reason: string;
  destinationFingerprint?: string;
};

export type SyncPlan = {
  id: string;
  createdAt: string;
  sourceTypes: string[];
  actions: SyncAction[];
  enrichment: { cached: number; processed: number; fallback: number; disabled: number };
};

export type ItemOutcome = {
  sourceKey: string;
  outcome: SyncActionKind;
  message: string;
  todoistTaskId?: string;
};

export type ApplyResult = {
  planId: string;
  dryRun: boolean;
  outcomes: ItemOutcome[];
};
