import type { AppConfig } from "../config.js";
import { sourceKey } from "../core/hash.js";
import type { ExternalItem, TaskCandidate, TaskEnrichment } from "../core/models.js";

export const MARKER_PREFIX = "task-sync:v1:";

export function stableMarker(item: ExternalItem): string {
  return `${MARKER_PREFIX}${Buffer.from(sourceKey(item.ref), "utf8").toString("base64url")}`;
}

function normalizeName(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function readableStatus(status: ExternalItem["status"]): string {
  if (!status) return "Unknown";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function plainText(value: string): string {
  return value
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*li(?:\s[^>]*)?>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function canvasMetadata(item: ExternalItem): string[] {
  if (item.ref.sourceType !== "canvas") return [];
  const metadata = item.providerMetadata ?? {};
  const points = typeof metadata.pointsPossible === "number" ? String(metadata.pointsPossible) : undefined;
  const submittedAt = typeof metadata.submittedAt === "string" ? metadata.submittedAt : undefined;
  const submissionTypes = Array.isArray(metadata.submissionTypes)
    ? metadata.submissionTypes.filter((value): value is string => typeof value === "string").map((value) => value.replaceAll("_", " ")).join(", ")
    : "";
  return [
    points ? `**Points:** ${points}` : undefined,
    submittedAt ? `**Submitted:** ${submittedAt}` : undefined,
    submissionTypes ? `**Submission:** ${submissionTypes}` : undefined,
  ].filter((value): value is string => Boolean(value));
}

export type MappingResolution = {
  destinationKey: string;
  warning?: string;
};

export function resolveMapping(item: ExternalItem, enrichment: TaskEnrichment, config: AppConfig): MappingResolution {
  const course = item.course;
  if (course) {
    const explicit = config.courseMappings.find((mapping) =>
      mapping.courseExternalId === course.externalId
      && (!mapping.sourceType || mapping.sourceType === item.ref.sourceType)
      && (!mapping.connectionId || mapping.connectionId === item.ref.connectionId));
    if (explicit) return { destinationKey: explicit.destinationKey };

    const courseName = normalizeName(course.name);
    const alias = config.courseMappings.find((mapping) =>
      mapping.courseAlias
      && (!mapping.sourceType || mapping.sourceType === item.ref.sourceType)
      && (!mapping.connectionId || mapping.connectionId === item.ref.connectionId)
      && (courseName === normalizeName(mapping.courseAlias) || courseName.includes(normalizeName(mapping.courseAlias))));
    if (alias) return { destinationKey: alias.destinationKey };
  }

  if (enrichment.suggestedProjectKey
    && enrichment.confidence >= config.enrichment.mappingConfidence
    && Object.hasOwn(config.destinations, enrichment.suggestedProjectKey)) {
    return { destinationKey: enrichment.suggestedProjectKey };
  }

  return {
    destinationKey: config.defaultDestinationKey,
    warning: "No course mapping matched; default destination used",
  };
}

export function buildCandidate(item: ExternalItem, enrichment: TaskEnrichment, config: AppConfig): TaskCandidate {
  const mapping = resolveMapping(item, enrichment, config);
  const destination = config.destinations[mapping.destinationKey];
  if (!destination) throw new Error(`Unknown destination key: ${mapping.destinationKey}`);

  const warnings = [...enrichment.warnings];
  if (mapping.warning) warnings.push(mapping.warning);

  let resolvedDeadlineAt: string | undefined;
  let deadlineOrigin: TaskCandidate["deadlineOrigin"] = "none";
  if (item.dueAt) {
    resolvedDeadlineAt = item.dueAt;
    deadlineOrigin = "source";
    if (enrichment.inferredDueAt && enrichment.inferredDueAt !== item.dueAt) {
      warnings.push("Ignored inferred deadline because the source deadline is authoritative");
    }
  } else if (enrichment.inferredDueAt && enrichment.confidence >= config.enrichment.inferredDueConfidence) {
    resolvedDeadlineAt = enrichment.inferredDueAt;
    deadlineOrigin = "inferred";
    warnings.push("Deadline was inferred by the LLM");
  } else if (enrichment.inferredDueAt) {
    warnings.push("Inferred deadline was below the confidence threshold and was not applied");
  } else {
    warnings.push("Item has no authoritative deadline");
  }

  const marker = stableMarker(item);
  const assignmentDetails = plainText(item.description ?? enrichment.conciseDescription ?? "")
    .slice(0, config.enrichment.maxDescriptionCharacters)
    .trim();
  const metadata = [
    item.course ? `**Course:** ${item.course.name}` : undefined,
    `**Status:** ${readableStatus(item.status)}`,
    resolvedDeadlineAt ? `**Due (${deadlineOrigin}):** ${resolvedDeadlineAt}` : "**Due:** Not provided",
    item.sourceUpdatedAt ? `**Source updated:** ${item.sourceUpdatedAt}` : undefined,
    ...canvasMetadata(item),
  ].filter((value): value is string => Boolean(value));
  const descriptionParts = [
    metadata.join("\n"),
    assignmentDetails ? `**Assignment details**\n${assignmentDetails}` : undefined,
    item.sourceUrl ? `[Open in source](${item.sourceUrl})` : undefined,
    `<!-- ${marker} -->`,
  ].filter((value): value is string => Boolean(value));

  return {
    source: item,
    enrichment,
    resolvedTitle: enrichment.cleanedTitle.trim() || item.title.trim(),
    resolvedDescription: descriptionParts.join("\n\n"),
    ...(resolvedDeadlineAt ? { resolvedDeadlineAt } : {}),
    deadlineOrigin,
    destinationKey: mapping.destinationKey,
    ...(destination.projectId ? { projectId: destination.projectId } : {}),
    ...(destination.sectionId ? { sectionId: destination.sectionId } : {}),
    labels: enrichment.suggestedLabels,
    warnings,
  };
}
