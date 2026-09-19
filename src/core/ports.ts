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
  listItems(options?: { signal?: AbortSignal }): Promise<ExternalItem[]>;
  diagnose(): Promise<DiagnosticReport>;
}

export interface EnrichmentService {
  enrich(item: ExternalItem, options?: { force?: boolean; signal?: AbortSignal }): Promise<EnrichmentResult>;
}

export interface TodoistDestination {
  diagnose(options?: { mutate?: boolean }): Promise<DiagnosticReport>;
  getTask(id: string, options?: { signal?: AbortSignal }): Promise<TodoistTask | undefined>;
  findByStableMarker(marker: string, options?: { signal?: AbortSignal }): Promise<TodoistTask[]>;
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

export type RunSummary = {
  id: string;
  mode: "plan" | "apply";
  planId: string;
  origin: "cli" | "desktop";
  startedAt: string;
  finishedAt?: string;
  summary: Record<string, number>;
};

export type RunOutcome = {
  sourceKey: string;
  outcome: string;
  detail: string;
};

export type RunDetail = RunSummary & { outcomes: RunOutcome[] };

export type PlanRecord = {
  plan: SyncPlan;
  digest: string;
  expiresAt: string;
  configFingerprint: string;
  applyStatus: "planned" | "applying" | "applied" | "failed";
  appliedAt?: string;
  origin: "cli" | "desktop";
};

export interface SyncRepository {
  getEnrichment(cacheKey: string): CachedEnrichment | undefined;
  putEnrichment(value: CachedEnrichment): void;
  getMapping(sourceKey: string): SyncMapping | undefined;
  putMapping(mapping: SyncMapping): void;
  recordSource(item: ExternalItem): void;
  savePlan(plan: SyncPlan, metadata?: Partial<Omit<PlanRecord, "plan">>): void;
  loadPlan(planId: string): SyncPlan | undefined;
  getPlanRecord(planId: string): PlanRecord | undefined;
  claimPlanForApply(planId: string, digest: string, now: string): boolean;
  finishPlanApply(planId: string, status: "applied" | "failed"): void;
  startRun(mode: "plan" | "apply", planId: string, origin?: "cli" | "desktop"): string;
  recordOutcome(runId: string, sourceKey: string, outcome: string, detail: string): void;
  finishRun(runId: string, summary: Record<string, number>): void;
  listRecentRuns(limit?: number): RunSummary[];
  getRun(runId: string): RunDetail | undefined;
  close(): void;
}
