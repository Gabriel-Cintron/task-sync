import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { candidateToTodoistInput, destinationFingerprint, sourceKey, todoistTaskFingerprint } from "../core/hash.js";
import type {
  ApplyResult,
  ItemOutcome,
  SyncAction,
  SyncPlan,
} from "../core/models.js";
import type { EnrichmentService, SourceAdapter, SyncRepository, TodoistDestination } from "../core/ports.js";
import { buildCandidate, stableMarker } from "./policy.js";

function summary(outcomes: Array<{ outcome: string }>): Record<string, number> {
  return outcomes.reduce<Record<string, number>>((counts, value) => {
    counts[value.outcome] = (counts[value.outcome] ?? 0) + 1;
    return counts;
  }, {});
}

function requestId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class SyncEngine {
  public constructor(
    private readonly repository: SyncRepository,
    private readonly enrichment: EnrichmentService,
    private readonly todoist: TodoistDestination,
    private readonly config: AppConfig,
    private readonly origin: "cli" | "desktop" = "cli",
  ) {}

  public async plan(sources: SourceAdapter[], options: { forceReenrich?: boolean; signal?: AbortSignal } = {}): Promise<SyncPlan> {
    const actions: SyncAction[] = [];
    const enrichmentCounts = { cached: 0, processed: 0, fallback: 0, disabled: 0 };

    for (const source of sources) {
      options.signal?.throwIfAborted();
      let items;
      try {
        items = await source.listItems(options.signal ? { signal: options.signal } : {});
      } catch (error) {
        options.signal?.throwIfAborted();
        actions.push({
          kind: "error",
          sourceKey: `${source.sourceType}:${source.connectionId}:*`,
          reason: error instanceof Error ? error.message : "Source listing failed",
        });
        continue;
      }

      for (const item of items) {
        options.signal?.throwIfAborted();
        const key = sourceKey(item.ref);
        this.repository.recordSource(item);
        if ((item.status === "submitted" || item.status === "completed") && this.config.sync.completedSourceItems === "skip") {
          actions.push({ kind: "skip", sourceKey: key, reason: `Source item is ${item.status}; completion policy is skip` });
          continue;
        }

        try {
          const enriched = await this.enrichment.enrich(item, { force: options.forceReenrich ?? false, ...(options.signal ? { signal: options.signal } : {}) });
          enrichmentCounts[enriched.provenance.status] += 1;
          if (!enriched.enrichment.isActionable) {
            actions.push({ kind: "skip", sourceKey: key, reason: "Enrichment classified item as non-actionable" });
            continue;
          }
          const candidate = buildCandidate(item, enriched.enrichment, this.config);
          const fingerprint = destinationFingerprint(candidate);
          const mapping = this.repository.getMapping(key);
          if (mapping) {
            const task = await this.todoist.getTask(mapping.todoistTaskId, options.signal ? { signal: options.signal } : {});
            if (!task) {
              actions.push({ kind: "conflict", sourceKey: key, candidate, reason: "Mapped Todoist task is missing; refusing to create a possible duplicate", destinationFingerprint: fingerprint });
              continue;
            }
            if (mapping.lastDestinationFingerprint === fingerprint && todoistTaskFingerprint(task) === fingerprint) {
              actions.push({ kind: "unchanged", sourceKey: key, candidate, todoistTaskId: mapping.todoistTaskId, reason: "Source and Todoist destination fingerprints are unchanged", destinationFingerprint: fingerprint });
              continue;
            }
            const reason = mapping.lastDestinationFingerprint === fingerprint
              ? "Todoist task drifted from the last applied state"
              : "Resolved task content changed";
            actions.push({ kind: "update", sourceKey: key, candidate, todoistTaskId: mapping.todoistTaskId, reason, destinationFingerprint: fingerprint });
            continue;
          }

          const recovered = await this.todoist.findByStableMarker(stableMarker(item), options.signal ? { signal: options.signal } : {});
          if (recovered.length > 1) {
            actions.push({ kind: "conflict", sourceKey: key, candidate, reason: `${recovered.length} Todoist tasks contain the stable marker`, destinationFingerprint: fingerprint });
          } else if (recovered[0]) {
            actions.push({ kind: "update", sourceKey: key, candidate, todoistTaskId: recovered[0].id, reason: "Recovered missing local mapping from stable marker", destinationFingerprint: fingerprint });
          } else {
            actions.push({ kind: "create", sourceKey: key, candidate, reason: "No existing mapping or stable marker found", destinationFingerprint: fingerprint });
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          actions.push({ kind: "error", sourceKey: key, reason: error instanceof Error ? error.message : "Unknown planning failure" });
        }
      }
    }

    options.signal?.throwIfAborted();

    const plan: SyncPlan = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      sourceTypes: sources.map((source) => source.sourceType),
      actions,
      enrichment: enrichmentCounts,
    };
    this.repository.savePlan(plan);
    const runId = this.repository.startRun("plan", plan.id, this.origin);
    for (const action of actions) this.repository.recordOutcome(runId, action.sourceKey, action.kind, action.reason);
    const runSummary = summary(actions.map((action) => ({ outcome: action.kind })));
    runSummary.warning = actions.reduce((count, action) => count + (action.candidate?.warnings.length ?? 0), 0);
    this.repository.finishRun(runId, runSummary);
    return plan;
  }

  public async apply(plan: SyncPlan): Promise<ApplyResult> {
    const outcomes: ItemOutcome[] = [];
    const runId = this.repository.startRun("apply", plan.id, this.origin);
    for (const action of plan.actions) {
      let outcome: ItemOutcome;
      try {
        outcome = await this.applyAction(plan.id, action);
      } catch (error) {
        outcome = {
          sourceKey: action.sourceKey,
          outcome: "error",
          message: error instanceof Error ? error.message : "Unknown Todoist write failure",
          ...(action.todoistTaskId ? { todoistTaskId: action.todoistTaskId } : {}),
        };
      }
      outcomes.push(outcome);
      this.repository.recordOutcome(runId, outcome.sourceKey, outcome.outcome, outcome.message);
    }
    this.repository.finishRun(runId, summary(outcomes));
    return { planId: plan.id, dryRun: false, outcomes };
  }

  private async applyAction(planId: string, action: SyncAction): Promise<ItemOutcome> {
    if (action.kind !== "create" && action.kind !== "update") {
      return { sourceKey: action.sourceKey, outcome: action.kind, message: action.reason, ...(action.todoistTaskId ? { todoistTaskId: action.todoistTaskId } : {}) };
    }
    if (!action.candidate || !action.destinationFingerprint) throw new Error("Plan action lacks a candidate or destination fingerprint");
    const input = candidateToTodoistInput(action.candidate);
    const idempotencyKey = requestId(`${planId}:${action.sourceKey}:${action.kind}`);
    const task = action.kind === "create"
      ? await this.todoist.createTask(input, idempotencyKey)
      : await this.todoist.updateTask(action.todoistTaskId!, input, idempotencyKey);
    this.repository.putMapping({
      sourceKey: action.sourceKey,
      todoistTaskId: task.id,
      lastDestinationFingerprint: action.destinationFingerprint,
      updatedAt: new Date().toISOString(),
    });
    return { sourceKey: action.sourceKey, outcome: action.kind, message: `${action.kind === "create" ? "Created" : "Updated"} Todoist task`, todoistTaskId: task.id };
  }
}
