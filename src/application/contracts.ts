import { z } from "zod";
import { AppConfigSchema, type AppConfig } from "../config.js";
import { TaskCandidateSchema } from "../core/models.js";
import type { SyncPlan } from "../core/models.js";
import type { RunSummary } from "../core/ports.js";
export type { PlanRecord, RunDetail, RunOutcome, RunSummary } from "../core/ports.js";

export const ProviderSchema = z.enum(["todoist", "canvas", "openai", "classroom"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const AppPathsSchema = z.object({
  root: z.string().min(1),
  env: z.string().min(1),
  config: z.string().min(1),
  database: z.string().min(1),
  secrets: z.string().min(1),
}).strict();
export type AppPaths = z.infer<typeof AppPathsSchema>;

export const SetupInputSchema = z.object({
  credentials: z.object({
    todoistApiToken: z.string().optional(),
    canvasBaseUrl: z.string().optional(),
    canvasAccessToken: z.string().optional(),
    openaiApiKey: z.string().optional(),
    googleClientSecretFile: z.string().optional(),
    googleTokenFile: z.string().optional(),
  }).strict().optional(),
  config: AppConfigSchema.optional(),
}).strict();
export type SetupInput = z.infer<typeof SetupInputSchema>;

export const ImportRequestSchema = z.object({
  envFile: z.string().optional(),
  configFile: z.string().optional(),
  databaseFile: z.string().optional(),
  googleClientFile: z.string().optional(),
  googleTokenFile: z.string().optional(),
}).strict().refine((value) => Object.values(value).some(Boolean), "Select at least one file to import");
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export type ImportResult = {
  imported: string[];
  backups: string[];
};
export const ImportResultSchema = z.object({ imported: z.array(z.string()), backups: z.array(z.string()) }).strict();

export type CredentialStatus = Record<Provider, boolean>;

export type SetupStatus = {
  credentials: CredentialStatus;
  config: AppConfig;
  paths: AppPaths;
};

export const CredentialStatusSchema = z.object({ todoist: z.boolean(), canvas: z.boolean(), openai: z.boolean(), classroom: z.boolean() }).strict();
export const SetupStatusSchema = z.object({ credentials: CredentialStatusSchema, config: AppConfigSchema, paths: AppPathsSchema }).strict();

export type BootstrapState = SetupStatus & {
  setupComplete: boolean;
  busy: boolean;
  lastRun?: RunSummary;
};

export const PlanRequestSchema = z.object({
  source: z.enum(["canvas", "classroom", "all"]).default("canvas"),
  forceReenrich: z.boolean().default(false),
}).strict();
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export type PlanView = {
  plan: SyncPlan;
  digest: string;
  expiresAt: string;
  counts: Record<string, number>;
  canApply: boolean;
};

export const CourseSummarySchema = z.object({ externalId: z.string().min(1), name: z.string().min(1) }).strict();
export type CourseSummary = z.infer<typeof CourseSummarySchema>;

export type DestinationProject = { id: string; name: string };
export type DestinationSection = { id: string; name: string; projectId: string };
export type DestinationCatalog = { projects: DestinationProject[]; sections: DestinationSection[] };
export const DestinationCatalogSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  sections: z.array(z.object({ id: z.string(), name: z.string(), projectId: z.string() }).strict()),
}).strict();

export const RunSummarySchema = z.object({
  id: z.string().uuid(), mode: z.enum(["plan", "apply"]), planId: z.string().uuid(), origin: z.enum(["cli", "desktop"]),
  startedAt: z.string().datetime({ offset: true }), finishedAt: z.string().datetime({ offset: true }).optional(), summary: z.record(z.number()),
}).strict();
export const RunDetailSchema = RunSummarySchema.extend({ outcomes: z.array(z.object({ sourceKey: z.string(), outcome: z.string(), detail: z.string() }).strict()) }).strict();

const SyncActionSchema = z.object({
  kind: z.enum(["create", "update", "unchanged", "skip", "conflict", "error"]),
  sourceKey: z.string(), candidate: TaskCandidateSchema.optional(), todoistTaskId: z.string().optional(), reason: z.string(), destinationFingerprint: z.string().optional(),
}).strict();
export const SyncPlanSchema = z.object({
  id: z.string().uuid(), createdAt: z.string().datetime({ offset: true }), sourceTypes: z.array(z.string()), actions: z.array(SyncActionSchema),
  enrichment: z.object({ cached: z.number().int(), processed: z.number().int(), fallback: z.number().int(), disabled: z.number().int() }).strict(),
}).strict();
export const PlanViewSchema = z.object({ plan: SyncPlanSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime({ offset: true }), counts: z.record(z.number().int()), canApply: z.boolean() }).strict();
export const ApplyResultSchema = z.object({
  planId: z.string().uuid(), dryRun: z.boolean(), outcomes: z.array(z.object({ sourceKey: z.string(), outcome: z.enum(["create", "update", "unchanged", "skip", "conflict", "error"]), message: z.string(), todoistTaskId: z.string().optional() }).strict()),
}).strict();
export const DiagnosticReportSchema = z.object({ provider: z.string(), ok: z.boolean(), checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() }).strict()) }).strict();
export const BootstrapStateSchema = SetupStatusSchema.extend({ setupComplete: z.boolean(), busy: z.boolean(), lastRun: RunSummarySchema.optional() }).strict();

export const OperationCancellationSchema = z.object({
  accepted: z.boolean(),
  operation: z.string().optional(),
}).strict();
export type OperationCancellation = z.infer<typeof OperationCancellationSchema>;

export const ApplyPlanRequestSchema = z.object({
  planId: z.string().uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ApplyPlanRequest = z.infer<typeof ApplyPlanRequestSchema>;

export const DiagnosticOptionsSchema = z.object({ mutate: z.boolean().default(false) }).strict().default({});
export type DiagnosticOptions = z.infer<typeof DiagnosticOptionsSchema>;
