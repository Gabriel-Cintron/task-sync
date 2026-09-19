import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { CanvasAdapter } from "./adapters/canvas.js";
import { GoogleClassroomAdapter } from "./adapters/google-classroom.js";
import { TodoistAdapter } from "./adapters/todoist.js";
import type { SourceAdapter } from "./core/ports.js";
import type { SyncRepository } from "./core/ports.js";
import type { EnrichmentService } from "./core/ports.js";
import { CachedEnrichmentService } from "./enrichment/service.js";
import { OpenAIEnrichmentGenerator } from "./enrichment/openai-generator.js";

export type RuntimeEnvironment = Record<string, string | undefined>;

export function excludedCanvasCourseIds(config: AppConfig): ReadonlySet<string> | undefined {
  const excluded = config.courseMappings.filter((mapping) =>
    mapping.courseExternalId
    && (!mapping.sourceType || mapping.sourceType === "canvas")
    && (!mapping.connectionId || mapping.connectionId === config.sources.canvas.connectionId)
    && !mapping.enabled);
  return excluded.length ? new Set(excluded.map((mapping) => mapping.courseExternalId!)) : undefined;
}

export function createTodoistFromEnvironment(environment: RuntimeEnvironment = process.env): TodoistAdapter {
  const token = environment.TODOIST_API_TOKEN;
  if (!token) throw new Error("TODOIST_API_TOKEN is required");
  return new TodoistAdapter(token);
}

export function createClassroomFromEnvironment(config: AppConfig, environment: RuntimeEnvironment = process.env): GoogleClassroomAdapter {
  const clientFile = environment.GOOGLE_CLIENT_SECRET_FILE;
  const tokenFile = environment.GOOGLE_TOKEN_FILE;
  if (!clientFile || !tokenFile) throw new Error("GOOGLE_CLIENT_SECRET_FILE and GOOGLE_TOKEN_FILE are required");
  return new GoogleClassroomAdapter(
    config.sources.googleClassroom.connectionId,
    resolve(clientFile),
    resolve(tokenFile),
  );
}

export function createSources(config: AppConfig, selection: "canvas" | "classroom" | "all", environment: RuntimeEnvironment = process.env): SourceAdapter[] {
  const sources: SourceAdapter[] = [];
  if (selection === "canvas" || selection === "all") {
    const baseUrl = environment.CANVAS_BASE_URL;
    const token = environment.CANVAS_ACCESS_TOKEN;
    if (baseUrl && token) {
      sources.push(new CanvasAdapter(
        config.sources.canvas.connectionId,
        baseUrl,
        token,
        fetch,
        excludedCanvasCourseIds(config),
        config.sync.undatedSourceItems === "include",
      ));
    }
    else if (selection === "canvas") throw new Error("CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN are required");
  }
  if (selection === "classroom" || selection === "all") {
    try {
      sources.push(createClassroomFromEnvironment(config, environment));
    } catch (error) {
      if (selection === "classroom") throw error;
    }
  }
  if (sources.length === 0) throw new Error("No configured source adapters matched the selection");
  return sources;
}

export function createEnrichmentFromEnvironment(
  config: AppConfig,
  repository: SyncRepository,
  environment: RuntimeEnvironment = process.env,
): EnrichmentService {
  const apiKey = environment.OPENAI_API_KEY;
  const generator = apiKey ? new OpenAIEnrichmentGenerator(apiKey, config.enrichment.model) : undefined;
  return new CachedEnrichmentService(repository, generator, config);
}
