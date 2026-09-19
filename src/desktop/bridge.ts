import type { ApplyResult } from "../core/models.js";
import type { DiagnosticReport } from "../core/ports.js";
import type {
  ApplyPlanRequest,
  BootstrapState,
  CourseSummary,
  DestinationCatalog,
  DiagnosticOptions,
  ImportRequest,
  ImportResult,
  PlanRequest,
  PlanView,
  Provider,
  RunDetail,
  RunSummary,
  SetupInput,
  SetupStatus,
} from "../application/contracts.js";

export const IPC = {
  bootstrap: "task-sync:bootstrap",
  importSetup: "task-sync:import-setup",
  saveSetup: "task-sync:save-setup",
  removeCredential: "task-sync:remove-credential",
  diagnose: "task-sync:diagnose",
  discoverCanvasCourses: "task-sync:discover-canvas-courses",
  listTodoistDestinations: "task-sync:list-todoist-destinations",
  createPlan: "task-sync:create-plan",
  applyPlan: "task-sync:apply-plan",
  listRecentRuns: "task-sync:list-recent-runs",
  getRun: "task-sync:get-run",
  chooseFile: "task-sync:choose-file",
  authorizeClassroom: "task-sync:authorize-classroom",
  openExternal: "task-sync:open-external",
} as const;

export type FileKind = "env" | "config" | "database" | "google-client" | "google-token";

export type TaskSyncDesktopApi = {
  getBootstrapState(): Promise<BootstrapState>;
  importExistingSetup(input: ImportRequest): Promise<ImportResult>;
  saveSetup(input: SetupInput): Promise<SetupStatus>;
  removeCredential(provider: Provider): Promise<SetupStatus>;
  diagnose(provider: Provider, options?: DiagnosticOptions): Promise<DiagnosticReport>;
  discoverCanvasCourses(): Promise<CourseSummary[]>;
  listTodoistDestinations(): Promise<DestinationCatalog>;
  createPlan(input: PlanRequest): Promise<PlanView>;
  applyPlan(input: ApplyPlanRequest): Promise<ApplyResult>;
  listRecentRuns(limit?: number): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunDetail>;
  chooseFile(kind: FileKind): Promise<string | undefined>;
  authorizeClassroom(): Promise<SetupStatus>;
  openExternal(url: string): Promise<void>;
};

declare global {
  interface Window {
    taskSync: TaskSyncDesktopApi;
  }
}
