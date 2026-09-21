import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { desktopPaths, SettingsStore } from "../../src/application/settings-store.js";
import { testConfig } from "../helpers.js";

function temporaryStore(): { root: string; store: SettingsStore } {
  const root = mkdtempSync(join(tmpdir(), "task-sync-settings-"));
  return { root, store: new SettingsStore(desktopPaths(root)) };
}

describe("desktop settings", () => {
  it("stores credentials atomically and only exposes redacted status", () => {
    const { store } = temporaryStore();
    const status = store.save({
      credentials: { todoistApiToken: "todo-secret", canvasBaseUrl: "https://canvas.example.edu", canvasAccessToken: "canvas-secret" },
      config: testConfig(),
    });

    expect(status.credentials).toMatchObject({ todoist: true, canvas: true, openai: false, classroom: false });
    expect(JSON.stringify(status)).not.toContain("todo-secret");
    expect(readFileSync(store.paths.env, "utf8")).toContain('TODOIST_API_TOKEN="todo-secret"');

    expect(store.removeCredential("todoist").credentials.todoist).toBe(false);
    expect(readFileSync(store.paths.env, "utf8")).not.toContain("todo-secret");
  });

  it("validates all imports before activation and leaves originals unchanged", async () => {
    const { root, store } = temporaryStore();
    store.save({ credentials: { todoistApiToken: "existing" }, config: testConfig() });
    const originalDesktopEnv = readFileSync(store.paths.env, "utf8");
    const cliEnv = join(root, "cli.env");
    const invalidConfig = join(root, "invalid.json");
    writeFileSync(cliEnv, "TODOIST_API_TOKEN=imported\n", "utf8");
    writeFileSync(invalidConfig, JSON.stringify({ enrichment: { mode: "not-a-mode" } }), "utf8");

    await expect(store.importExisting({ envFile: cliEnv, configFile: invalidConfig })).rejects.toThrow();
    expect(readFileSync(store.paths.env, "utf8")).toBe(originalDesktopEnv);
    expect(readFileSync(cliEnv, "utf8")).toBe("TODOIST_API_TOKEN=imported\n");
  });

  it("copies a Desktop OAuth client and never considers it authorized before a token exists", async () => {
    const { root, store } = temporaryStore();
    const oauth = join(root, "client.json");
    writeFileSync(oauth, JSON.stringify({ installed: { client_id: "id", client_secret: "secret", redirect_uris: ["http://localhost"] } }), "utf8");

    const result = await store.importExisting({ googleClientFile: oauth });
    expect(result.imported).toContain("google-client");
    expect(store.status().credentials.classroom).toBe(false);
    expect(readFileSync(oauth, "utf8")).toContain("client_secret");
  });

  it("copies OAuth files referenced by an imported env into desktop-owned storage", async () => {
    const { root, store } = temporaryStore();
    const oauth = join(root, "client.json");
    const token = join(root, "token.json");
    const cliEnv = join(root, "cli.env");
    writeFileSync(oauth, JSON.stringify({ installed: { client_id: "id", client_secret: "secret", redirect_uris: ["http://localhost"] } }), "utf8");
    writeFileSync(token, JSON.stringify({ refresh_token: "refresh" }), "utf8");
    writeFileSync(cliEnv, "GOOGLE_CLIENT_SECRET_FILE=client.json\nGOOGLE_TOKEN_FILE=token.json\n", "utf8");

    await store.importExisting({ envFile: cliEnv });
    const environment = store.environment();
    expect(environment.GOOGLE_CLIENT_SECRET_FILE).toBe(join(store.paths.secrets, "google-oauth-client.json"));
    expect(environment.GOOGLE_TOKEN_FILE).toBe(join(store.paths.secrets, "google-oauth-token.json"));
    expect(store.status().credentials.classroom).toBe(true);

    store.removeCredential("classroom");
    expect(existsSync(join(store.paths.secrets, "google-oauth-client.json"))).toBe(false);
    expect(existsSync(join(store.paths.secrets, "google-oauth-token.json"))).toBe(false);
  });

  it("imports a consistent validated SQLite snapshot", async () => {
    const { root, store } = temporaryStore();
    const sourcePath = join(root, "source.sqlite");
    const source = new DatabaseSync(sourcePath);
    source.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('preserved');");

    await store.importExisting({ databaseFile: sourcePath });
    source.close();
    const imported = new DatabaseSync(store.paths.database, { readOnly: true });
    expect(imported.prepare("SELECT value FROM sample").get()).toEqual({ value: "preserved" });
    expect(imported.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    imported.close();
  });

  it("rejects a corrupt SQLite import without replacing existing state", async () => {
    const { root, store } = temporaryStore();
    const existing = new DatabaseSync(store.paths.database);
    existing.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('yes');");
    existing.close();
    const corrupt = join(root, "corrupt.sqlite");
    writeFileSync(corrupt, "not sqlite", "utf8");

    await expect(store.importExisting({ databaseFile: corrupt })).rejects.toThrow();
    const after = new DatabaseSync(store.paths.database, { readOnly: true });
    expect(after.prepare("SELECT value FROM preserved").get()).toEqual({ value: "yes" });
    after.close();
  });
});
