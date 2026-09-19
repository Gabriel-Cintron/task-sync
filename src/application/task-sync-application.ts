import { AppConfigSchema, type AppConfig } from "../config.js";
import { CanvasAdapter } from "../adapters/canvas.js";
import type { ApplyResult, ExternalItem, TaskEnrichment } from "../core/models.js";
import type { DiagnosticReport, EnrichmentService, SourceAdapter, SyncRepository, TodoistDestination } from "../core/ports.js";
import { sha256, stableJson } from "../core/hash.js";
import { createClassroomFromEnvironment, createEnrichmentFromEnvironment, createSources, createTodoistFromEnvironment, type RuntimeEnvironment } from "../composition.js";
import { OpenAIEnrichmentGenerator } from "../enrichment/openai-generator.js";
import { messyAssignmentFixture } from "../fixtures/messy-assignment.js";
import { SqliteSyncRepository } from "../persistence/sqlite-repository.js";
import { SyncEngine } from "../sync/engine.js";
import {
  ApplyPlanRequestSchema,
  DiagnosticOptionsSchema,
  ImportRequestSchema,
  PlanRequestSchema,
  ProviderSchema,
  SetupInputSchema,
  type ApplyPlanRequest,
  type BootstrapState,
  type CourseSummary,
  type DestinationCatalog,
  type DiagnosticOptions,
  type ImportRequest,
  type ImportResult,
  type PlanRequest,
  type PlanView,
  type Provider,
  type RunDetail,
  type RunSummary,
  type SetupInput,
  type SetupStatus,
} from "./contracts.js";
import { OperationMutex } from "./mutex.js";
import type { SettingsStore } from "./settings-store.js";

type DiscoverableCanvas = SourceAdapter & { listCourses(): Promise<CourseSummary[]> };
type DiscoverableTodoist = TodoistDestination & { listDestinations(): Promise<DestinationCatalog> };
type AuthorizableClassroom = SourceAdapter & { authorize(options?: { onAuthorizationUrl?: (url: string) => void }): Promise<void> };

export type ApplicationFactories = {
  repository(path: string): SyncRepository;
  todoist(environment: RuntimeEnvironment): DiscoverableTodoist;
  canvas(config: AppConfig, environment: RuntimeEnvironment): DiscoverableCanvas;
  classroom(config: AppConfig, environment: RuntimeEnvironment): AuthorizableClassroom;
  sources(config: AppConfig, selection: PlanRequest["source"], environment: RuntimeEnvironment): SourceAdapter[];
  enrichment(config: AppConfig, repository: SyncRepository, environment: RuntimeEnvironment): EnrichmentService;
  openAI(apiKey: string, model: string): { generate(item: ExternalItem, context: { allowedLabels: string[]; allowedProjectKeys: string[]; maxDescriptionCharacters: number }): Promise<TaskEnrichment> };
};

const defaultFactories: ApplicationFactories = {
  repository: (path) => new SqliteSyncRepository(path),
  todoist: (environment) => createTodoistFromEnvironment(environment),
  canvas: (config, environment) => {
    const baseUrl = environment.CANVAS_BASE_URL;
    const token = environment.CANVAS_ACCESS_TOKEN;
    if (!baseUrl || !token) throw new Error("Canvas URL and access token are required");
    return new CanvasAdapter(config.sources.canvas.connectionId, baseUrl, token);
  },
  classroom: (config, environment) => createClassroomFromEnvironment(config, environment),
  sources: (config, selection, environment) => createSources(config, selection, environment),
  enrichment: (config, repository, environment) => createEnrichmentFromEnvironment(config, repository, environment),
  openAI: (apiKey, model) => new OpenAIEnrichmentGenerator(apiKey, model),
};

function counts(actions: Array<{ kind: string }>): Record<string, number> {
  return actions.reduce<Record<string, number>>((result, action) => {
    result[action.kind] = (result[action.kind] ?? 0) + 1;
    return result;
  }, {});
}

export class TaskSyncApplication {
  private readonly mutex = new OperationMutex();

  public constructor(
    private readonly settings: SettingsStore,
    private readonly factories: ApplicationFactories = defaultFactories,
    private readonly origin: "cli" | "desktop" = "desktop",
  ) {}

  public get busy(): boolean {
    return this.mutex.busy;
  }

  public getBootstrapState(): Promise<BootstrapState> {
    const status = this.settings.status();
    const runs = this.withRepository((repository) => repository.listRecentRuns(1));
    return Promise.resolve({
      ...status,
      setupComplete: status.credentials.todoist && status.credentials.canvas,
      busy: this.busy,
      ...(runs[0] ? { lastRun: runs[0] } : {}),
    });
  }

  public async saveSetup(input: SetupInput): Promise<SetupStatus> {
    return this.mutex.run("save setup", () => this.settings.save(SetupInputSchema.parse(input)));
  }

  public async removeCredential(provider: Provider): Promise<SetupStatus> {
    const parsed = ProviderSchema.parse(provider);
    return this.mutex.run("remove credential", () => this.settings.removeCredential(parsed));
  }

  public async importExistingSetup(input: ImportRequest): Promise<ImportResult> {
    return this.mutex.run("import setup", () => this.settings.importExisting(ImportRequestSchema.parse(input)));
  }

  public async diagnose(provider: Provider, options: DiagnosticOptions = { mutate: false }): Promise<DiagnosticReport> {
    const parsedProvider = ProviderSchema.parse(provider);
    const parsedOptions = DiagnosticOptionsSchema.parse(options);
    return this.mutex.run(`diagnose ${parsedProvider}`, async () => {
      const config = this.settings.config();
      const environment = this.settings.environment();
      if (parsedProvider === "todoist") return this.factories.todoist(environment).diagnose(parsedOptions);
      if (parsedProvider === "canvas") return this.factories.canvas(config, environment).diagnose();
      if (parsedProvider === "classroom") return this.factories.classroom(config, environment).diagnose();
      const apiKey = environment.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OpenAI API key is required");
      const enrichment = await this.factories.openAI(apiKey, config.enrichment.model).generate(messyAssignmentFixture, {
        allowedLabels: config.enrichment.allowedLabels,
        allowedProjectKeys: Object.keys(config.destinations),
        maxDescriptionCharacters: config.enrichment.maxDescriptionCharacters,
      });
      return {
        provider: "OpenAI",
        ok: true,
        checks: [
          { name: "authentication", ok: true, detail: "Responses API accepted the key" },
          { name: "structured output", ok: true, detail: `Validated candidate: ${enrichment.cleanedTitle}` },
        ],
      };
    });
  }

  public async discoverCanvasCourses(): Promise<CourseSummary[]> {
    return this.mutex.run("discover Canvas courses", async () => {
      const courses = await this.factories.canvas(this.settings.config(), this.settings.environment()).listCourses();
      return courses.sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  public async listTodoistDestinations(): Promise<DestinationCatalog> {
    return this.mutex.run("list Todoist destinations", async () => {
      const catalog = await this.factories.todoist(this.settings.environment()).listDestinations();
      return {
        projects: catalog.projects.sort((left, right) => left.name.localeCompare(right.name)),
        sections: catalog.sections.sort((left, right) => left.name.localeCompare(right.name)),
      };
    });
  }

  public async createPlan(input: PlanRequest): Promise<PlanView> {
    const parsed = PlanRequestSchema.parse(input);
    return this.mutex.run("create sync plan", async () => {
      const config = this.settings.config();
      const environment = this.settings.environment();
      return this.withRepository(async (repository) => {
        const engine = new SyncEngine(
          repository,
          this.factories.enrichment(config, repository, environment),
          this.factories.todoist(environment),
          config,
          this.origin,
        );
        const plan = await engine.plan(this.factories.sources(config, parsed.source, environment), { forceReenrich: parsed.forceReenrich });
        const digest = sha256(stableJson(plan));
        const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
        repository.savePlan(plan, {
          digest,
          expiresAt,
          configFingerprint: this.configFingerprint(config),
          applyStatus: "planned",
          origin: this.origin,
        });
        const actionCounts = counts(plan.actions);
        return {
          plan,
          digest,
          expiresAt,
          counts: actionCounts,
          canApply: (actionCounts.create ?? 0) + (actionCounts.update ?? 0) > 0,
        };
      });
    });
  }

  public async applyPlan(input: ApplyPlanRequest): Promise<ApplyResult> {
    const parsed = ApplyPlanRequestSchema.parse(input);
    return this.mutex.run("apply sync plan", async () => this.withRepository(async (repository) => {
      const record = repository.getPlanRecord(parsed.planId);
      if (!record) throw new Error("The selected plan no longer exists");
      if (record.digest !== parsed.digest) throw new Error("The plan digest does not match the reviewed plan");
      if (record.configFingerprint !== this.configFingerprint(this.settings.config())) throw new Error("Settings changed after preview; create a new plan");
      if (record.applyStatus !== "planned") throw new Error(`This plan cannot be applied because its status is ${record.applyStatus}`);
      if (new Date(record.expiresAt).getTime() <= Date.now()) throw new Error("This plan expired; create a new preview");
      if (!repository.claimPlanForApply(parsed.planId, parsed.digest, new Date().toISOString())) throw new Error("This plan was already claimed or expired");

      const config = this.settings.config();
      const environment = this.settings.environment();
      const engine = new SyncEngine(
        repository,
        this.factories.enrichment(config, repository, environment),
        this.factories.todoist(environment),
        config,
        this.origin,
      );
      try {
        const result = await engine.apply(record.plan);
        repository.finishPlanApply(parsed.planId, "applied");
        return result;
      } catch (error) {
        repository.finishPlanApply(parsed.planId, "failed");
        throw error;
      }
    }));
  }

  public listRecentRuns(limit = 20): Promise<RunSummary[]> {
    return Promise.resolve(this.withRepository((repository) => repository.listRecentRuns(limit)));
  }

  public getRun(runId: string): Promise<RunDetail> {
    const run = this.withRepository((repository) => repository.getRun(runId));
    return run ? Promise.resolve(run) : Promise.reject(new Error("Run not found"));
  }

  public async authorizeClassroom(openAuthorizationUrl: (url: string) => void): Promise<SetupStatus> {
    return this.mutex.run("authorize Google Classroom", async () => {
      await this.factories.classroom(this.settings.config(), this.settings.environment()).authorize({ onAuthorizationUrl: openAuthorizationUrl });
      return this.settings.status();
    });
  }

  private configFingerprint(config: AppConfig): string {
    return sha256(stableJson(AppConfigSchema.parse(config)));
  }

  private withRepository<T>(operation: (repository: SyncRepository) => T): T;
  private withRepository<T>(operation: (repository: SyncRepository) => Promise<T>): Promise<T>;
  private withRepository<T>(operation: (repository: SyncRepository) => T | Promise<T>): T | Promise<T> {
    const repository = this.factories.repository(this.settings.paths.database);
    try {
      const result = operation(repository);
      if (result instanceof Promise) return result.finally(() => repository.close());
      repository.close();
      return result;
    } catch (error) {
      repository.close();
      throw error;
    }
  }
}
