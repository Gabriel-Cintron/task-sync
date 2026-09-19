#!/usr/bin/env node
import "dotenv/config";
import { Command, Option } from "commander";
import { loadConfig } from "./config.js";
import { createClassroomFromEnvironment, createSources, createTodoistFromEnvironment } from "./composition.js";
import { safeErrorMessage } from "./core/errors.js";
import type { DiagnosticReport, EnrichmentService } from "./core/ports.js";
import { CachedEnrichmentService } from "./enrichment/service.js";
import { OpenAIEnrichmentGenerator } from "./enrichment/openai-generator.js";
import { messyAssignmentFixture } from "./fixtures/messy-assignment.js";
import { SqliteSyncRepository } from "./persistence/sqlite-repository.js";
import { SyncEngine } from "./sync/engine.js";
import { buildCandidate } from "./sync/policy.js";
import { CanvasAdapter } from "./adapters/canvas.js";

function createEnrichment(config: ReturnType<typeof loadConfig>, repository: SqliteSyncRepository): EnrichmentService {
  const apiKey = process.env.OPENAI_API_KEY;
  const generator = apiKey ? new OpenAIEnrichmentGenerator(apiKey, config.enrichment.model) : undefined;
  return new CachedEnrichmentService(repository, generator, config);
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

function printSync(plan: Awaited<ReturnType<SyncEngine["plan"]>>, applied: Awaited<ReturnType<SyncEngine["apply"]>> | undefined, json: boolean): void {
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
    const config = loadConfig();
    const repository = new SqliteSyncRepository(config.databasePath);
    try {
      const engine = new SyncEngine(repository, createEnrichment(config, repository), createTodoistFromEnvironment(), config);
      const plan = await engine.plan(createSources(config, options.source), { forceReenrich: options.forceReenrich });
      const result = options.apply ? await engine.apply(plan) : undefined;
      printSync(plan, result, options.json);
      if (plan.actions.some((action) => action.kind === "error" || action.kind === "conflict")) process.exitCode = 2;
    } finally {
      repository.close();
    }
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
    const config = loadConfig();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required");
    const enrichment = await new OpenAIEnrichmentGenerator(apiKey, config.enrichment.model).generate(messyAssignmentFixture, {
      allowedLabels: config.enrichment.allowedLabels,
      allowedProjectKeys: Object.keys(config.destinations),
      maxDescriptionCharacters: config.enrichment.maxDescriptionCharacters,
    });
    printDiagnostic({ provider: "OpenAI", ok: true, checks: [
      { name: "authentication", ok: true, detail: "Responses API accepted the key" },
      { name: "structured output", ok: true, detail: `Strict enrichment schema returned a candidate titled “${enrichment.cleanedTitle}”` },
    ] }, options.json);
  });

check.command("canvas")
  .option("--json", "machine-readable output", false)
  .action(async (options: { json: boolean }) => {
    const config = loadConfig();
    const baseUrl = process.env.CANVAS_BASE_URL;
    const token = process.env.CANVAS_ACCESS_TOKEN;
    if (!baseUrl || !token) throw new Error("CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN are required");
    printDiagnostic(await new CanvasAdapter(config.sources.canvas.connectionId, baseUrl, token).diagnose(), options.json);
  });

check.command("classroom")
  .option("--json", "machine-readable output", false)
  .action(async (options: { json: boolean }) => {
    printDiagnostic(await createClassroomFromEnvironment(loadConfig()).diagnose(), options.json);
  });

check.command("todoist")
  .option("--mutate", "create/update/delete a clearly labeled compatibility task", false)
  .option("--json", "machine-readable output", false)
  .action(async (options: { mutate: boolean; json: boolean }) => {
    printDiagnostic(await createTodoistFromEnvironment().diagnose({ mutate: options.mutate }), options.json);
  });

program.command("auth")
  .description("Authorize a provider")
  .argument("<provider>", "provider name")
  .action(async (provider: string) => {
    if (provider !== "classroom") throw new Error("Only 'classroom' supports an interactive authorization command");
    await createClassroomFromEnvironment(loadConfig()).authorize();
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`task-sync: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
