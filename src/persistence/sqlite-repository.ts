import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExternalItem, SyncPlan } from "../core/models.js";
import type { CachedEnrichment, SyncMapping, SyncRepository } from "../core/ports.js";
import { sourceKey } from "../core/hash.js";

type Row = Record<string, unknown>;

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
        plan_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        plan_id TEXT NOT NULL,
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
    `);
  }

  public getEnrichment(cacheKey: string): CachedEnrichment | undefined {
    const row = this.db.prepare("SELECT cache_key, result_json, provenance_json FROM enrichment_cache WHERE cache_key = ?")
      .get(cacheKey) as Row | undefined;
    if (!row) return undefined;
    return {
      cacheKey: String(row.cache_key),
      resultJson: String(row.result_json),
      provenanceJson: String(row.provenance_json),
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
      sourceKey: String(row.source_key),
      todoistTaskId: String(row.todoist_task_id),
      lastDestinationFingerprint: String(row.last_destination_fingerprint),
      updatedAt: String(row.updated_at),
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

  public savePlan(plan: SyncPlan): void {
    this.db.prepare("INSERT OR REPLACE INTO sync_plans(id, created_at, plan_json) VALUES (?, ?, ?)")
      .run(plan.id, plan.createdAt, JSON.stringify(plan));
  }

  public loadPlan(planId: string): SyncPlan | undefined {
    const row = this.db.prepare("SELECT plan_json FROM sync_plans WHERE id = ?").get(planId) as Row | undefined;
    return row ? JSON.parse(String(row.plan_json)) as SyncPlan : undefined;
  }

  public startRun(mode: "plan" | "apply", planId: string): string {
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO sync_runs(id, mode, plan_id, started_at) VALUES (?, ?, ?, ?)")
      .run(id, mode, planId, new Date().toISOString());
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

  public close(): void {
    this.db.close();
  }
}
