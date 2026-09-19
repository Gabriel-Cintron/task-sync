import type { AppConfig } from "../config.js";
import { enrichmentInputFingerprint, sha256 } from "../core/hash.js";
import {
  TaskEnrichmentSchema,
  type EnrichmentProvenance,
  type EnrichmentResult,
  type ExternalItem,
  type TaskEnrichment,
} from "../core/models.js";
import type { EnrichmentService, SyncRepository } from "../core/ports.js";

export const PROMPT_VERSION = "school-obligation-v1";
export const SCHEMA_VERSION = "task-enrichment-v1";

export interface EnrichmentGenerator {
  generate(item: ExternalItem, context: {
    allowedLabels: string[];
    allowedProjectKeys: string[];
    maxDescriptionCharacters: number;
  }): Promise<TaskEnrichment>;
}

function fallback(item: ExternalItem, warning?: string): TaskEnrichment {
  return {
    isActionable: item.kind === "assignment" && item.status !== "completed",
    cleanedTitle: item.title.trim(),
    ...(item.description ? { conciseDescription: item.description.slice(0, 1000).trim() } : {}),
    suggestedLabels: [],
    confidence: 1,
    warnings: warning ? [warning] : [],
  };
}

function parseJson<T>(json: string): T {
  return JSON.parse(json) as T;
}

export class CachedEnrichmentService implements EnrichmentService {
  public constructor(
    private readonly repository: SyncRepository,
    private readonly generator: EnrichmentGenerator | undefined,
    private readonly config: AppConfig,
  ) {}

  public async enrich(item: ExternalItem, options: { force?: boolean } = {}): Promise<EnrichmentResult> {
    const inputFingerprint = enrichmentInputFingerprint(item);
    const cacheKey = sha256([
      inputFingerprint,
      PROMPT_VERSION,
      SCHEMA_VERSION,
      this.config.enrichment.model,
    ].join(":"));

    if (this.config.enrichment.mode === "disabled") {
      return this.wrap(fallback(item), inputFingerprint, "disabled");
    }

    if (!options.force) {
      const cached = this.repository.getEnrichment(cacheKey);
      if (cached) {
        const enrichment = TaskEnrichmentSchema.parse(parseJson<unknown>(cached.resultJson));
        const provenance = parseJson<EnrichmentProvenance>(cached.provenanceJson);
        return { enrichment, provenance: { ...provenance, status: "cached" } };
      }
    }

    if (!this.generator) {
      if (this.config.enrichment.mode === "required") throw new Error("OpenAI enrichment is required but OPENAI_API_KEY is missing");
      return this.wrap(fallback(item, "OpenAI unavailable; deterministic fallback used"), inputFingerprint, "fallback");
    }

    try {
      const generated = TaskEnrichmentSchema.parse(await this.generator.generate(item, {
        allowedLabels: this.config.enrichment.allowedLabels,
        allowedProjectKeys: Object.keys(this.config.destinations),
        maxDescriptionCharacters: this.config.enrichment.maxDescriptionCharacters,
      }));
      const enrichment: TaskEnrichment = {
        ...generated,
        cleanedTitle: generated.cleanedTitle.trim() || item.title.trim(),
        suggestedLabels: generated.suggestedLabels.filter((label) => this.config.enrichment.allowedLabels.includes(label)),
        ...(generated.suggestedProjectKey && Object.hasOwn(this.config.destinations, generated.suggestedProjectKey)
          ? { suggestedProjectKey: generated.suggestedProjectKey }
          : { suggestedProjectKey: undefined }),
      };
      const result = this.wrap(TaskEnrichmentSchema.parse(enrichment), inputFingerprint, "processed");
      this.repository.putEnrichment({
        cacheKey,
        resultJson: JSON.stringify(result.enrichment),
        provenanceJson: JSON.stringify(result.provenance),
      });
      return result;
    } catch (error) {
      if (this.config.enrichment.mode === "required") throw error;
      const message = error instanceof Error ? error.message : "unknown enrichment failure";
      return this.wrap(fallback(item, `OpenAI enrichment failed; fallback used: ${message}`), inputFingerprint, "fallback");
    }
  }

  private wrap(enrichment: TaskEnrichment, inputFingerprint: string, status: EnrichmentProvenance["status"]): EnrichmentResult {
    return {
      enrichment,
      provenance: {
        model: this.config.enrichment.model,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        inputFingerprint,
        createdAt: new Date().toISOString(),
        status,
        warnings: enrichment.warnings,
      },
    };
  }
}
