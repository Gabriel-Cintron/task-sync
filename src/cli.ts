#!/usr/bin/env node
import "dotenv/config";
import { Command, Option } from "commander";
import { resolve } from "node:path";
import { TaskSyncApplication } from "./application/task-sync-application.js";
import { SettingsStore } from "./application/settings-store.js";
import { loadConfig } from "./config.js";
import { createEnrichmentFromEnvironment } from "./composition.js";
import { safeErrorMessage } from "./core/errors.js";
import type { DiagnosticReport, EnrichmentService } from "./core/ports.js";
import type { ApplyResult, SyncPlan } from "./core/models.js";
import { messyAssignmentFixture } from "./fixtures/messy-assignment.js";
import { SqliteSyncRepository } from "./persistence/sqlite-repository.js";
import { buildCandidate } from "./sync/policy.js";

function createEnrichment(config: ReturnType<typeof loadConfig>, repository: SqliteSyncRepository): EnrichmentService {
  return createEnrichmentFromEnvironment(config, repository);
}

function createCliApplication(): TaskSyncApplication {
  const root = process.cwd();
  const configPath = resolve(process.env.TASK_SYNC_CONFIG ?? "./task-sync.config.json");
  const config = loadConfig(configPath);
  return new TaskSyncApplication(new SettingsStore({
    root,
    env: resolve(root, ".env"),
    config: configPath,
    database: resolve(config.databasePath),
    secrets: root,
  }), undefined, "cli");
}

function printDiagnostic(report: DiagnosticReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.provider}: ${report.ok ? "compatible" : "failed"}\n`);
  for (const check of report.checks) process.stdout.write(`  ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}\n`);
}

function actionCounts(actions: Array<{ kind: string }>): Record<string, number> {
  return actions.reduce<Record<string, number>>((result, action) => {
    result[action.kind] = (result[action.kind] ?? 0) + 1;
    return result;
  }, {});
}

function printSync(plan: SyncPlan, applied: ApplyResult | undefined, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ plan, apply: applied ?? null }, null, 2)}\n`);
    return;
  }
  const counts = actionCounts(plan.actions);
  process.stdout.write(`Sources: ${plan.sourceTypes.join(", ")}\n`);
  process.stdout.write(`OpenAI enrichment: ${plan.enrichment.cached} cached, ${plan.enrichment.processed} processed, ${plan.enrichment.fallback} fallback, ${plan.enrichment.disabled} disabled\n`);
  process.stdout.write(`Sync plan: ${Object.entries(counts).map(([kind, count]) => `${count} ${kind}`).join(", ") || "no actions"}\n`);
  for (const action of plan.actions) {
    process.stdout.write(`  ${action.kind.toUpperCase()} ${action.sourceKey}: ${action.reason}\n`);
    for (const warning of action.candidate?.warnings ?? []) process.stdout.write(`    warning: ${warning}\n`);
  }
  if (!applied) process.stdout.write("Todoist: dry run; no changes applied\n");
  else process.stdout.write(`Todoist: applied; ${applied.outcomes.filter((value) => value.outcome === "error").length} error(s)\n`);
  process.stdout.write(`Plan ID: ${plan.id}\n`);
}

const program = new Command();
program.name("task-sync").description("Safely sync school obligations to Todoist").version("0.1.0");

program.command("sync")
  .description("Plan a sync; only write to Todoist with --apply")
  .addOption(new Option("--source <source>", "source adapter").choices(["canvas", "classroom", "all"]).default("all"))
  .option("--apply", "apply the generated current plan", false)
  .option("--dry-run", "explicitly request the default no-write behavior", false)
  .option("--force-reenrich", "ignore cached enrichments", false)
  .option("--json", "machine-readable output", false)
  .action(async (options: { source: "canvas" | "classroom" | "all"; apply: boolean; dryRun: boolean; forceReenrich: boolean; json: boolean }) => {
    if (options.apply && options.dryRun) throw new Error("Choose --apply or --dry-run, not both");
    const application = createCliApplication();
    const view = await application.createPlan({ source: options.source, forceReenrich: options.forceReenrich });
    const result = options.apply ? await application.applyPlan({ planId: view.plan.id, digest: view.digest }) : undefined;
    printSync(view.plan, result, options.json);
    if (view.plan.actions.some((action) => action.kind === "error" || action.kind === "conflict")) process.exitCode = 2;
  });

program.command("enrich-fixture")
  .description("Enrich a synthetic assignment and show the safe task candidate")
  .option("--force-reenrich", "ignore a cached enrichment", false)
  .action(async (options: { forceReenrich: boolean }) => {
    const config = loadConfig();
    const repository = new SqliteSyncRepository(config.databasePath);
    try {
      const result = await createEnrichment(config, repository).enrich(messyAssignmentFixture, { force: options.forceReenrich });
      process.stdout.write(`${JSON.stringify({ candidate: buildCandidate(messyAssignmentFixture, result.enrichment, config), provenance: result.provenance }, null, 2)}\n`);
    } finally {
      repository.close();
    }
  });

const check = program.command("check").description("Run opt-in provider compatibility diagnostics");

check.command("openai")
  .option("--json", "machine-readable output", false)
  .action(async (options: { json: boolean }) => {
    printDiagnostic(await createCliApplication().diagnose("openai"), options.json);
  });

check.command("canvas")
  .option("--json", "machine-readable output", false)
  .action(async (options: { json: boolean }) => {
    printDiagnostic(await createCliApplication().diagnose("canvas"), options.json);
  });

check.command("classroom")
  .option("--json", "machine-readable output", false)
  .action(async (options: { json: boolean }) => {
    printDiagnostic(await createCliApplication().diagnose("classroom"), options.json);
  });

check.command("todoist")
  .option("--mutate", "create/update/delete a clearly labeled compatibility task", false)
  .option("--json", "machine-readable output", false)
  .action(async (options: { mutate: boolean; json: boolean }) => {
    printDiagnostic(await createCliApplication().diagnose("todoist", { mutate: options.mutate }), options.json);
  });

program.command("auth")
  .description("Authorize a provider")
  .argument("<provider>", "provider name")
  .action(async (provider: string) => {
    if (provider !== "classroom") throw new Error("Only 'classroom' supports an interactive authorization command");
    await createCliApplication().authorizeClassroom((url) => process.stdout.write(`Open this URL in a browser:\n${url}\n`));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`task-sync: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
