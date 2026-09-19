import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { OpenAIEnrichmentSchema, type ExternalItem, type TaskEnrichment } from "../core/models.js";
import type { EnrichmentGenerator } from "./service.js";

export class OpenAIEnrichmentGenerator implements EnrichmentGenerator {
  private readonly client: OpenAI;

  public constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey, timeout: 20_000, maxRetries: 2 });
  }

  public async generate(item: ExternalItem, context: {
    allowedLabels: string[];
    allowedProjectKeys: string[];
    maxDescriptionCharacters: number;
  }, options: { signal?: AbortSignal } = {}): Promise<TaskEnrichment> {
    const description = item.description?.slice(0, context.maxDescriptionCharacters) ?? null;
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      instructions: [
        "Turn a school source item into one Todoist task candidate.",
        "Preserve meaning. Do not invent obligations, identifiers, links, completion state, study plans, schedules, or subtasks.",
        "Only infer a deadline when sourceDueAt is null and the text states a concrete deadline.",
        "Only suggest labels and project keys from the supplied allowlists.",
        "Use warnings for ambiguity. Confidence describes the whole extraction.",
      ].join(" "),
      input: JSON.stringify({
        kind: item.kind,
        title: item.title,
        description,
        sourceDueAt: item.dueAt ?? null,
        courseName: item.course?.name ?? null,
        allowedLabels: context.allowedLabels,
        allowedProjectKeys: context.allowedProjectKeys,
      }),
      text: { format: zodTextFormat(OpenAIEnrichmentSchema, "task_enrichment") },
    }, { signal: options.signal });
    const parsed = response.output_parsed;
    if (!parsed) throw new Error("OpenAI returned no parsed enrichment (possible refusal or incomplete response)");
    return {
      isActionable: parsed.isActionable,
      cleanedTitle: parsed.cleanedTitle,
      ...(parsed.conciseDescription ? { conciseDescription: parsed.conciseDescription } : {}),
      ...(parsed.suggestedProjectKey ? { suggestedProjectKey: parsed.suggestedProjectKey } : {}),
      suggestedLabels: parsed.suggestedLabels,
      ...(parsed.inferredDueAt ? { inferredDueAt: parsed.inferredDueAt } : {}),
      confidence: parsed.confidence,
      warnings: parsed.warnings,
    };
  }
}
