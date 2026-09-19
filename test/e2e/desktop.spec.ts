import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { arch, platform } from "node:process";
import { join, resolve } from "node:path";

function executablePath(): string {
  const folder = resolve(`desktop-out/Task Sync-${platform}-${arch}`);
  if (platform === "win32") return join(folder, "task-sync.exe");
  if (platform === "darwin") return join(folder, "Task Sync.app", "Contents", "MacOS", "task-sync");
  return join(folder, "task-sync");
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; data: string }> {
  const data = mkdtempSync(join(tmpdir(), "task-sync-e2e-"));
  const app = await electron.launch({ executablePath: executablePath(), args: platform === "linux" ? ["--no-sandbox"] : [], env: { ...process.env, TASK_SYNC_E2E: "1", TASK_SYNC_USER_DATA_DIR: data, TASK_SYNC_E2E_WRITE_LOG: join(data, "todoist-writes.log") } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, data };
}

async function completeSetup(page: Page): Promise<void> {
  await page.getByTestId("start-fresh").click();
  await page.getByTestId("todoist-token").fill("test-token");
  await page.getByTestId("todoist-save").click();
  await expect(page.getByRole("heading", { name: "Connect Canvas" })).toBeVisible();
  await page.getByTestId("canvas-url").fill("https://canvas.example.edu");
  await page.getByTestId("canvas-token").fill("test-canvas-token");
  await page.getByTestId("canvas-save").click();
  await expect(page.getByRole("heading", { name: "Choose enrichment" })).toBeVisible();
  await page.getByTestId("openai-skip").click();
  await expect(page.getByRole("heading", { name: "Map your courses" })).toBeVisible();
  await expect(page.getByText("Biology", { exact: true })).toBeVisible();
  await page.getByTestId("mapping-continue").click();
  await expect(page.getByRole("heading", { name: "Ready for your first preview" })).toBeVisible();
}

test("fresh Canvas setup previews before writing and applies only safe rows once", async () => {
  const { app, page, data } = await launch();
  try {
    await completeSetup(page);
    await page.getByTestId("first-preview").click();
    await expect(page.getByRole("heading", { name: "Review before applying" })).toBeVisible();
    await expect(page.locator(".summary-cell").filter({ hasText: "create" })).toContainText("1");
    await expect(page.locator(".summary-cell").filter({ hasText: "conflict" })).toContainText("1");
    await expect(page.locator(".summary-cell").filter({ hasText: "error" })).toContainText("1");
    await expect(page.getByText("2 excluded rows.")).toBeVisible();
    expect(existsSync(join(data, "todoist-writes.log"))).toBe(false);
    await page.getByRole("button", { name: "conflict 1" }).click();
    await expect(page.locator(".plan-item")).toHaveCount(1);
    await page.getByRole("button", { name: "All 3" }).click();

    const planReference = await page.getByTestId("apply-plan").evaluate((element) => ({ planId: element.dataset.planId!, digest: element.dataset.planDigest! }));

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("apply-plan").click();
    await expect(page.getByRole("heading", { name: "The last 20 runs" })).toBeVisible();
    await expect(page.getByText("Apply · 3 items")).toBeVisible();
    await expect(page.getByText("Preview · 3 items")).toBeVisible();
    await page.getByRole("button", { name: "View details" }).first().click();
    await expect(page.getByText("Created Todoist task")).toBeVisible();
    await expect(page.getByText("Synthetic enrichment failure")).toBeVisible();
    expect(readFileSync(join(data, "todoist-writes.log"), "utf8")).toBe("create\n");
    const repeated = await page.evaluate(async (reference) => {
      try { await window.taskSync.applyPlan(reference); return "unexpected success"; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    }, planReference);
    expect(repeated).toContain("status is applied");
  } finally {
    await app.close();
  }
});

test("imports CLI settings by copy and keeps Classroom optional", async () => {
  const { app, page, data } = await launch();
  try {
    const cliEnv = join(data, "source.env");
    writeFileSync(cliEnv, "TODOIST_API_TOKEN=cli-todo\nCANVAS_BASE_URL=https://canvas.example.edu\nCANVAS_ACCESS_TOKEN=cli-canvas\n", "utf8");
    const before = readFileSync(cliEnv, "utf8");
    await page.evaluate(async (path) => window.taskSync.importExistingSetup({ envFile: path }), cliEnv);
    expect(readFileSync(cliEnv, "utf8")).toBe(before);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your sync workspace" })).toBeVisible();
    await expect(page.getByText("Google Classroom")).toBeVisible();
    await expect(page.getByText("Optional · Advanced")).toBeVisible();
  } finally {
    await app.close();
  }
});
