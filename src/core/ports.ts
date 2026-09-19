import type {
  EnrichmentResult,
  ExternalItem,
  SyncPlan,
  TodoistTask,
  TodoistTaskInput,
} from "./models.js";

export interface SourceAdapter {
  readonly sourceType: string;
  readonly connectionId: string;
  listItems(): Promise<ExternalItem[]>;
  diagnose(): Promise<DiagnosticReport>;
}

export interface EnrichmentService {
  enrich(item: ExternalItem, options?: { force?: boolean }): Promise<EnrichmentResult>;
}

export interface TodoistDestination {
  diagnose(options?: { mutate?: boolean }): Promise<DiagnosticReport>;
  getTask(id: string): Promise<TodoistTask | undefined>;
  findByStableMarker(marker: string): Promise<TodoistTask[]>;
  createTask(input: TodoistTaskInput, requestId: string): Promise<TodoistTask>;
  updateTask(id: string, input: TodoistTaskInput, requestId: string): Promise<TodoistTask>;
}

export type DiagnosticReport = {
  provider: string;
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
};

export type SyncMapping = {
  sourceKey: string;
  todoistTaskId: string;
  lastDestinationFingerprint: string;
  updatedAt: string;
};

export type CachedEnrichment = {
  cacheKey: string;
  resultJson: string;
  provenanceJson: string;
};

export interface SyncRepository {
  getEnrichment(cacheKey: string): CachedEnrichment | undefined;
  putEnrichment(value: CachedEnrichment): void;
  getMapping(sourceKey: string): SyncMapping | undefined;
  putMapping(mapping: SyncMapping): void;
  recordSource(item: ExternalItem): void;
  savePlan(plan: SyncPlan): void;
  loadPlan(planId: string): SyncPlan | undefined;
  startRun(mode: "plan" | "apply", planId: string): string;
  recordOutcome(runId: string, sourceKey: string, outcome: string, detail: string): void;
  finishRun(runId: string, summary: Record<string, number>): void;
  close(): void;
}
