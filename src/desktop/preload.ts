import { contextBridge, ipcRenderer } from "electron";
import type { DiagnosticOptions, ImportRequest, PlanRequest, Provider, SetupInput } from "../application/contracts.js";
import { IPC, type FileKind, type TaskSyncDesktopApi } from "./bridge.js";

const api: TaskSyncDesktopApi = {
  getBootstrapState: () => ipcRenderer.invoke(IPC.bootstrap) as ReturnType<TaskSyncDesktopApi["getBootstrapState"]>,
  importExistingSetup: (input: ImportRequest) => ipcRenderer.invoke(IPC.importSetup, input) as ReturnType<TaskSyncDesktopApi["importExistingSetup"]>,
  saveSetup: (input: SetupInput) => ipcRenderer.invoke(IPC.saveSetup, input) as ReturnType<TaskSyncDesktopApi["saveSetup"]>,
  removeCredential: (provider: Provider) => ipcRenderer.invoke(IPC.removeCredential, provider) as ReturnType<TaskSyncDesktopApi["removeCredential"]>,
  diagnose: (provider: Provider, options?: DiagnosticOptions) => ipcRenderer.invoke(IPC.diagnose, { provider, options }) as ReturnType<TaskSyncDesktopApi["diagnose"]>,
  discoverCanvasCourses: () => ipcRenderer.invoke(IPC.discoverCanvasCourses) as ReturnType<TaskSyncDesktopApi["discoverCanvasCourses"]>,
  listTodoistDestinations: () => ipcRenderer.invoke(IPC.listTodoistDestinations) as ReturnType<TaskSyncDesktopApi["listTodoistDestinations"]>,
  createPlan: (input: PlanRequest) => ipcRenderer.invoke(IPC.createPlan, input) as ReturnType<TaskSyncDesktopApi["createPlan"]>,
  applyPlan: (input) => ipcRenderer.invoke(IPC.applyPlan, input) as ReturnType<TaskSyncDesktopApi["applyPlan"]>,
  listRecentRuns: (limit?: number) => ipcRenderer.invoke(IPC.listRecentRuns, limit) as ReturnType<TaskSyncDesktopApi["listRecentRuns"]>,
  getRun: (runId: string) => ipcRenderer.invoke(IPC.getRun, runId) as ReturnType<TaskSyncDesktopApi["getRun"]>,
  chooseFile: (kind: FileKind) => ipcRenderer.invoke(IPC.chooseFile, kind) as ReturnType<TaskSyncDesktopApi["chooseFile"]>,
  authorizeClassroom: () => ipcRenderer.invoke(IPC.authorizeClassroom) as ReturnType<TaskSyncDesktopApi["authorizeClassroom"]>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as ReturnType<TaskSyncDesktopApi["openExternal"]>,
};

contextBridge.exposeInMainWorld("taskSync", api);
