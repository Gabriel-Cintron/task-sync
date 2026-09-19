import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("validates all imports before activation and leaves originals unchanged", () => {
    const { root, store } = temporaryStore();
    store.save({ credentials: { todoistApiToken: "existing" }, config: testConfig() });
    const originalDesktopEnv = readFileSync(store.paths.env, "utf8");
    const cliEnv = join(root, "cli.env");
    const invalidConfig = join(root, "invalid.json");
    writeFileSync(cliEnv, "TODOIST_API_TOKEN=imported\n", "utf8");
    writeFileSync(invalidConfig, JSON.stringify({ enrichment: { mode: "not-a-mode" } }), "utf8");

    expect(() => store.importExisting({ envFile: cliEnv, configFile: invalidConfig })).toThrow();
    expect(readFileSync(store.paths.env, "utf8")).toBe(originalDesktopEnv);
    expect(readFileSync(cliEnv, "utf8")).toBe("TODOIST_API_TOKEN=imported\n");
  });

  it("copies a Desktop OAuth client and never considers it authorized before a token exists", () => {
    const { root, store } = temporaryStore();
    const oauth = join(root, "client.json");
    writeFileSync(oauth, JSON.stringify({ installed: { client_id: "id", client_secret: "secret" } }), "utf8");

    const result = store.importExisting({ googleClientFile: oauth });
    expect(result.imported).toContain("google-client");
    expect(store.status().credentials.classroom).toBe(false);
    expect(readFileSync(oauth, "utf8")).toContain("client_secret");
  });
});
