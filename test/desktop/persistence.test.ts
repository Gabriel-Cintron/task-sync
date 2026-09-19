import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SyncPlan } from "../../src/core/models.js";
import { sha256, stableJson } from "../../src/core/hash.js";
import { SqliteSyncRepository } from "../../src/persistence/sqlite-repository.js";

function plan(): SyncPlan {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), sourceTypes: ["canvas"], actions: [], enrichment: { cached: 0, processed: 0, fallback: 0, disabled: 0 } };
}

describe("desktop persistence", () => {
  it("claims a reviewed plan only once and rejects expired plans", () => {
    const repository = new SqliteSyncRepository(":memory:");
    const current = plan();
    const digest = sha256(stableJson(current));
    repository.savePlan(current, { digest, expiresAt: new Date(Date.now() + 60_000).toISOString(), configFingerprint: "config", origin: "desktop" });
    expect(repository.claimPlanForApply(current.id, digest, new Date().toISOString())).toBe(true);
    expect(repository.claimPlanForApply(current.id, digest, new Date().toISOString())).toBe(false);

    const expired = plan();
    const expiredDigest = sha256(stableJson(expired));
    repository.savePlan(expired, { digest: expiredDigest, expiresAt: new Date(Date.now() - 1).toISOString(), configFingerprint: "config", origin: "desktop" });
    expect(repository.claimPlanForApply(expired.id, expiredDigest, new Date().toISOString())).toBe(false);
    repository.close();
  });

  it("migrates a legacy database without losing saved plans or runs", () => {
    const path = join(mkdtempSync(join(tmpdir(), "task-sync-migration-")), "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE sync_plans (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, plan_json TEXT NOT NULL);
      CREATE TABLE sync_runs (id TEXT PRIMARY KEY, mode TEXT NOT NULL, plan_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, summary_json TEXT);
      CREATE TABLE sync_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES sync_runs(id), source_key TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL);
    `);
    const legacyPlan = plan();
    legacy.prepare("INSERT INTO sync_plans VALUES (?, ?, ?)").run(legacyPlan.id, legacyPlan.createdAt, JSON.stringify(legacyPlan));
    const runId = crypto.randomUUID();
    legacy.prepare("INSERT INTO sync_runs VALUES (?, 'plan', ?, ?, ?, ?)").run(runId, legacyPlan.id, legacyPlan.createdAt, legacyPlan.createdAt, JSON.stringify({ create: 1 }));
    legacy.close();

    const repository = new SqliteSyncRepository(path);
    expect(repository.getPlanRecord(legacyPlan.id)?.origin).toBe("cli");
    expect(repository.listRecentRuns()).toEqual([expect.objectContaining({ id: runId, origin: "cli", summary: { create: 1 } })]);
    repository.close();
  });

  it("returns recent run summaries and per-item outcomes", () => {
    const repository = new SqliteSyncRepository(":memory:");
    const runId = repository.startRun("apply", crypto.randomUUID(), "desktop");
    repository.recordOutcome(runId, "canvas:school:1", "create", "Created Todoist task");
    repository.finishRun(runId, { create: 1 });
    expect(repository.getRun(runId)).toMatchObject({ origin: "desktop", summary: { create: 1 }, outcomes: [{ outcome: "create" }] });
    repository.close();
  });
});
