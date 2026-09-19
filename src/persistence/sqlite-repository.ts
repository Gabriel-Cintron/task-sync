import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExternalItem, SyncPlan } from "../core/models.js";
import type { CachedEnrichment, PlanRecord, RunDetail, RunSummary, SyncMapping, SyncRepository } from "../core/ports.js";
import { sha256, sourceKey, stableJson } from "../core/hash.js";

type Row = Record<string, unknown>;

function textColumn(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return fallback;
}

export class SqliteSyncRepository implements SyncRepository {
  private readonly db: DatabaseSync;

  public constructor(path: string) {
    const resolved = path === ":memory:" ? path : resolve(path);
    if (resolved !== ":memory:") mkdirSync(dirname(resolved), { recursive: true });
    this.db = new DatabaseSync(resolved);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_records (
        source_key TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        raw_fingerprint TEXT NOT NULL,
        source_updated_at TEXT,
        item_json TEXT NOT NULL,
        seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS enrichment_cache (
        cache_key TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_mappings (
        source_key TEXT PRIMARY KEY,
        todoist_task_id TEXT NOT NULL,
        last_destination_fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_plans (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        digest TEXT,
        expires_at TEXT,
        config_fingerprint TEXT,
        apply_status TEXT NOT NULL DEFAULT 'planned',
        applied_at TEXT,
        origin TEXT NOT NULL DEFAULT 'cli'
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'cli',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary_json TEXT
      );
      CREATE TABLE IF NOT EXISTS sync_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES sync_runs(id),
        source_key TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at DESC);
    `);
    this.ensureColumn("sync_plans", "digest", "TEXT");
    this.ensureColumn("sync_plans", "expires_at", "TEXT");
    this.ensureColumn("sync_plans", "config_fingerprint", "TEXT");
    this.ensureColumn("sync_plans", "apply_status", "TEXT NOT NULL DEFAULT 'planned'");
    this.ensureColumn("sync_plans", "applied_at", "TEXT");
    this.ensureColumn("sync_plans", "origin", "TEXT NOT NULL DEFAULT 'cli'");
    this.ensureColumn("sync_runs", "origin", "TEXT NOT NULL DEFAULT 'cli'");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((value) => String(value.name) === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  public getEnrichment(cacheKey: string): CachedEnrichment | undefined {
    const row = this.db.prepare("SELECT cache_key, result_json, provenance_json FROM enrichment_cache WHERE cache_key = ?")
      .get(cacheKey) as Row | undefined;
    if (!row) return undefined;
    return {
      cacheKey: textColumn(row.cache_key),
      resultJson: textColumn(row.result_json),
      provenanceJson: textColumn(row.provenance_json),
    };
  }

  public putEnrichment(value: CachedEnrichment): void {
    this.db.prepare(`
      INSERT INTO enrichment_cache(cache_key, result_json, provenance_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json,
        provenance_json=excluded.provenance_json, created_at=excluded.created_at
    `).run(value.cacheKey, value.resultJson, value.provenanceJson, new Date().toISOString());
  }

  public getMapping(key: string): SyncMapping | undefined {
    const row = this.db.prepare(`
      SELECT source_key, todoist_task_id, last_destination_fingerprint, updated_at
      FROM sync_mappings WHERE source_key = ?
    `).get(key) as Row | undefined;
    if (!row) return undefined;
    return {
      sourceKey: textColumn(row.source_key),
      todoistTaskId: textColumn(row.todoist_task_id),
      lastDestinationFingerprint: textColumn(row.last_destination_fingerprint),
      updatedAt: textColumn(row.updated_at),
    };
  }

  public putMapping(mapping: SyncMapping): void {
    this.db.prepare(`
      INSERT INTO sync_mappings(source_key, todoist_task_id, last_destination_fingerprint, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET todoist_task_id=excluded.todoist_task_id,
        last_destination_fingerprint=excluded.last_destination_fingerprint,
        updated_at=excluded.updated_at
    `).run(mapping.sourceKey, mapping.todoistTaskId, mapping.lastDestinationFingerprint, mapping.updatedAt);
  }

  public recordSource(item: ExternalItem): void {
    this.db.prepare(`
      INSERT INTO source_records(source_key, source_type, connection_id, external_id,
        raw_fingerprint, source_updated_at, item_json, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET raw_fingerprint=excluded.raw_fingerprint,
        source_updated_at=excluded.source_updated_at, item_json=excluded.item_json, seen_at=excluded.seen_at
    `).run(
      sourceKey(item.ref), item.ref.sourceType, item.ref.connectionId, item.ref.externalId,
      item.rawFingerprint, item.sourceUpdatedAt ?? null, JSON.stringify(item), new Date().toISOString(),
    );
  }

  public savePlan(plan: SyncPlan, metadata: Partial<Omit<PlanRecord, "plan">> = {}): void {
    const digest = metadata.digest ?? sha256(stableJson(plan));
    const expiresAt = metadata.expiresAt ?? new Date(new Date(plan.createdAt).getTime() + 15 * 60_000).toISOString();
    this.db.prepare(`
      INSERT INTO sync_plans(id, created_at, plan_json, digest, expires_at, config_fingerprint, apply_status, applied_at, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET plan_json=excluded.plan_json, digest=excluded.digest,
        expires_at=excluded.expires_at, config_fingerprint=excluded.config_fingerprint,
        apply_status=excluded.apply_status, applied_at=excluded.applied_at, origin=excluded.origin
    `).run(
      plan.id,
      plan.createdAt,
      JSON.stringify(plan),
      digest,
      expiresAt,
      metadata.configFingerprint ?? "",
      metadata.applyStatus ?? "planned",
      metadata.appliedAt ?? null,
      metadata.origin ?? "cli",
    );
  }

  public loadPlan(planId: string): SyncPlan | undefined {
    return this.getPlanRecord(planId)?.plan;
  }

  public getPlanRecord(planId: string): PlanRecord | undefined {
    const row = this.db.prepare(`
      SELECT plan_json, digest, expires_at, config_fingerprint, apply_status, applied_at, origin
      FROM sync_plans WHERE id = ?
    `).get(planId) as Row | undefined;
    if (!row) return undefined;
    const plan = JSON.parse(textColumn(row.plan_json)) as SyncPlan;
    return {
      plan,
      digest: textColumn(row.digest, sha256(stableJson(plan))),
      expiresAt: textColumn(row.expires_at, new Date(new Date(plan.createdAt).getTime() + 15 * 60_000).toISOString()),
      configFingerprint: textColumn(row.config_fingerprint),
      applyStatus: textColumn(row.apply_status, "planned") as PlanRecord["applyStatus"],
      ...(row.applied_at ? { appliedAt: textColumn(row.applied_at) } : {}),
      origin: textColumn(row.origin, "cli") as PlanRecord["origin"],
    };
  }

  public claimPlanForApply(planId: string, digest: string, now: string): boolean {
    const result = this.db.prepare(`
      UPDATE sync_plans SET apply_status = 'applying'
      WHERE id = ? AND digest = ? AND apply_status = 'planned' AND expires_at > ?
    `).run(planId, digest, now);
    return Number(result.changes) === 1;
  }

  public finishPlanApply(planId: string, status: "applied" | "failed"): void {
    this.db.prepare("UPDATE sync_plans SET apply_status = ?, applied_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), planId);
  }

  public startRun(mode: "plan" | "apply", planId: string, origin: "cli" | "desktop" = "cli"): string {
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO sync_runs(id, mode, plan_id, origin, started_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, mode, planId, origin, new Date().toISOString());
    return id;
  }

  public recordOutcome(runId: string, key: string, outcome: string, detail: string): void {
    this.db.prepare("INSERT INTO sync_outcomes(run_id, source_key, outcome, detail) VALUES (?, ?, ?, ?)")
      .run(runId, key, outcome, detail);
  }

  public finishRun(runId: string, summary: Record<string, number>): void {
    this.db.prepare("UPDATE sync_runs SET finished_at = ?, summary_json = ? WHERE id = ?")
      .run(new Date().toISOString(), JSON.stringify(summary), runId);
  }

  public listRecentRuns(limit = 20): RunSummary[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT id, mode, plan_id, origin, started_at, finished_at, summary_json
      FROM sync_runs ORDER BY started_at DESC LIMIT ?
    `).all(safeLimit) as Row[];
    return rows.map((row) => this.runSummary(row));
  }

  public getRun(runId: string): RunDetail | undefined {
    const row = this.db.prepare(`
      SELECT id, mode, plan_id, origin, started_at, finished_at, summary_json
      FROM sync_runs WHERE id = ?
    `).get(runId) as Row | undefined;
    if (!row) return undefined;
    const outcomes = this.db.prepare(`
      SELECT source_key, outcome, detail FROM sync_outcomes WHERE run_id = ? ORDER BY id
    `).all(runId) as Row[];
    return {
      ...this.runSummary(row),
      outcomes: outcomes.map((outcome) => ({
        sourceKey: textColumn(outcome.source_key),
        outcome: textColumn(outcome.outcome),
        detail: textColumn(outcome.detail),
      })),
    };
  }

  private runSummary(row: Row): RunSummary {
    return {
      id: textColumn(row.id),
      mode: textColumn(row.mode) as RunSummary["mode"],
      planId: textColumn(row.plan_id),
      origin: textColumn(row.origin, "cli") as RunSummary["origin"],
      startedAt: textColumn(row.started_at),
      ...(row.finished_at ? { finishedAt: textColumn(row.finished_at) } : {}),
      summary: row.summary_json ? JSON.parse(textColumn(row.summary_json)) as Record<string, number> : {},
    };
  }

  public close(): void {
    this.db.close();
  }
}
