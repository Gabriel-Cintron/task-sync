import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, type IpcMainInvokeEvent } from "electron";
import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { TaskSyncApplication } from "../application/task-sync-application.js";
import { ApplyPlanRequestSchema, ApplyResultSchema, BootstrapStateSchema, CourseSummarySchema, DestinationCatalogSchema, DiagnosticOptionsSchema, DiagnosticReportSchema, ImportRequestSchema, ImportResultSchema, PlanRequestSchema, PlanViewSchema, ProviderSchema, RunDetailSchema, RunSummarySchema, SetupInputSchema, SetupStatusSchema } from "../application/contracts.js";
import { desktopPaths, SettingsStore } from "../application/settings-store.js";
import { safeErrorMessage } from "../core/errors.js";
import { IPC, type FileKind } from "./bridge.js";
import { createSmokeFactories } from "./e2e-fakes.js";
import { isAllowedExternalUrl, isTrustedRendererUrl } from "./security.js";

protocol.registerSchemesAsPrivileged([{
  scheme: "task-sync",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
}]);

if (process.env.TASK_SYNC_E2E === "1" && process.env.TASK_SYNC_USER_DATA_DIR) {
  app.setPath("userData", resolve(process.env.TASK_SYNC_USER_DATA_DIR));
}

let mainWindow: BrowserWindow | undefined;
let application: TaskSyncApplication;
let forceClosing = false;

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return isTrustedRendererUrl(event.senderFrame?.url, MAIN_WINDOW_VITE_DEV_SERVER_URL);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedSender(event)) throw new Error("Untrusted renderer attempted a privileged operation");
}

function handle(channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown): void {
  ipcMain.handle(channel, async (event, input: unknown) => {
    assertTrustedSender(event);
    try {
      return await handler(event, input);
    } catch (error) {
      throw new Error(safeErrorMessage(error));
    }
  });
}

async function validated<T>(schema: z.ZodType<T>, value: T | Promise<T>): Promise<T> {
  return schema.parse(await value);
}

function registerIpcHandlers(): void {
  handle(IPC.bootstrap, () => validated(BootstrapStateSchema, application.getBootstrapState()));
  handle(IPC.importSetup, (_event, input) => validated(ImportResultSchema, application.importExistingSetup(ImportRequestSchema.parse(input))));
  handle(IPC.saveSetup, (_event, input) => validated(SetupStatusSchema, application.saveSetup(SetupInputSchema.parse(input))));
  handle(IPC.removeCredential, (_event, input) => validated(SetupStatusSchema, application.removeCredential(ProviderSchema.parse(input))));
  handle(IPC.diagnose, (_event, input) => {
    const parsed = z.object({ provider: ProviderSchema, options: DiagnosticOptionsSchema.optional() }).strict().parse(input);
    return validated(DiagnosticReportSchema, application.diagnose(parsed.provider, parsed.options));
  });
  handle(IPC.discoverCanvasCourses, () => validated(z.array(CourseSummarySchema), application.discoverCanvasCourses()));
  handle(IPC.listTodoistDestinations, () => validated(DestinationCatalogSchema, application.listTodoistDestinations()));
  handle(IPC.createPlan, (_event, input) => validated(PlanViewSchema, application.createPlan(PlanRequestSchema.parse(input))));
  handle(IPC.applyPlan, (_event, input) => validated(ApplyResultSchema, application.applyPlan(ApplyPlanRequestSchema.parse(input))));
  handle(IPC.listRecentRuns, (_event, input) => validated(z.array(RunSummarySchema), application.listRecentRuns(z.number().int().min(1).max(100).default(20).parse(input))));
  handle(IPC.getRun, (_event, input) => validated(RunDetailSchema, application.getRun(z.string().uuid().parse(input))));
  handle(IPC.chooseFile, async (_event, input) => chooseFile(z.enum(["env", "config", "database", "google-client", "google-token"]).parse(input)));
  handle(IPC.authorizeClassroom, () => validated(SetupStatusSchema, application.authorizeClassroom((url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com") throw new Error("Rejected unexpected Google authorization URL");
    void shell.openExternal(parsed.toString());
  })));
  handle(IPC.openExternal, async (_event, input) => {
    const parsed = new URL(z.string().url().parse(input));
    if (!isAllowedExternalUrl(parsed.toString())) throw new Error("Only HTTPS links can be opened");
    await shell.openExternal(parsed.toString());
  });
}

async function chooseFile(kind: FileKind): Promise<string | undefined> {
  const filters: Record<FileKind, Electron.FileFilter[]> = {
    env: [{ name: "Environment files", extensions: ["env"] }, { name: "All files", extensions: ["*"] }],
    config: [{ name: "JSON", extensions: ["json"] }],
    database: [{ name: "SQLite", extensions: ["sqlite", "db"] }],
    "google-client": [{ name: "Google OAuth JSON", extensions: ["json"] }],
    "google-token": [{ name: "Google OAuth token", extensions: ["json"] }],
  };
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openFile"], filters: filters[kind] });
  return result.canceled ? undefined : result.filePaths[0];
}

function registerLocalProtocol(): void {
  const rendererRoot = resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
  protocol.handle("task-sync", (request) => {
    const requested = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "") || "index.html";
    const target = resolve(rendererRoot, normalize(requested));
    if ((target !== rendererRoot && !target.startsWith(`${rendererRoot}${sep}`)) || !existsSync(target)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });
}

function secureSession(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.on("will-download", (event) => event.preventDefault());
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: "#f5f4ef",
    title: "Task Sync",
    windowStatePersistence: true,
    name: "main",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = isTrustedRendererUrl(url, MAIN_WINDOW_VITE_DEV_SERVER_URL);
    if (!allowed) event.preventDefault();
  });
  mainWindow.on("close", (event) => {
    if (!forceClosing && application.busy) {
      event.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: "warning",
        buttons: ["Keep working", "Force quit"],
        defaultId: 0,
        cancelId: 0,
        title: "Operation in progress",
        message: "Task Sync is still working. Force quitting may leave a sync partially applied.",
      });
      if (choice === 1) {
        forceClosing = true;
        app.exit(1);
      }
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await mainWindow.loadURL("task-sync://app/index.html");
  mainWindow.once("ready-to-show", () => mainWindow?.show());
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.setName("Task Sync");
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void app.whenReady().then(async () => {
    application = new TaskSyncApplication(
      new SettingsStore(desktopPaths(app.getPath("userData"))),
      process.env.TASK_SYNC_E2E === "1" ? createSmokeFactories() : undefined,
    );
    registerIpcHandlers();
    registerLocalProtocol();
    secureSession();
    await createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
