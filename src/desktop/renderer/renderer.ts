import "./styles.css";
import type { AppConfig } from "../../config.js";
import type { SyncActionKind } from "../../core/models.js";
import type { BootstrapState, CourseSummary, DestinationCatalog, ImportRequest, PlanView, Provider, RunSummary } from "../../application/contracts.js";

type Route = "welcome" | "setup" | "dashboard" | "plan" | "history" | "settings";

const main = document.querySelector<HTMLElement>("#main")!;
const toast = document.querySelector<HTMLElement>("#toast")!;
const state: {
  bootstrap?: BootstrapState;
  route: Route;
  setupStep: number;
  plan?: PlanView;
  planFilter: "all" | SyncActionKind;
  courses: CourseSummary[];
  coursesLoaded: boolean;
  destinations?: DestinationCatalog;
  importRequest: ImportRequest;
  uiOperation?: string;
} = { route: "dashboard", setupStep: 0, planFilter: "all", courses: [], coursesLoaded: false, importRequest: {} };

const providerNames: Record<Provider, string> = {
  todoist: "Todoist",
  canvas: "Canvas",
  openai: "OpenAI",
  classroom: "Google Classroom",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function friendlyDate(value?: string): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function showToast(message: string, error = false): void {
  toast.textContent = message;
  toast.className = `toast show${error ? " error" : ""}`;
  window.setTimeout(() => { toast.className = "toast"; }, 3500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runBusy<T>(
  button: HTMLButtonElement | null,
  work: () => Promise<T>,
  options: { name?: string; cancellable?: boolean } = {},
): Promise<T | undefined> {
  if (state.uiOperation) {
    showToast(`${state.uiOperation} is still running.`, true);
    return undefined;
  }
  const label = button?.textContent;
  const controls = [...main.querySelectorAll<HTMLButtonElement>("button")].map((control) => ({ control, disabled: control.disabled }));
  state.uiOperation = options.name ?? "Operation";
  for (const { control } of controls) control.disabled = true;
  if (button) button.textContent = "Working…";
  let cancelButton: HTMLButtonElement | undefined;
  if (button && options.cancellable) {
    cancelButton = document.createElement("button");
    cancelButton.className = "button secondary";
    cancelButton.textContent = "Cancel preview";
    cancelButton.dataset.testid = "cancel-preview";
    cancelButton.addEventListener("click", async () => {
      cancelButton!.disabled = true;
      cancelButton!.textContent = "Cancelling…";
      const result = await window.taskSync.cancelActiveOperation();
      if (!result.accepted) showToast("The preview already finished or cannot be cancelled.", true);
    });
    button.insertAdjacentElement("afterend", cancelButton);
  }
  try { return await work(); }
  catch (error) {
    const message = errorMessage(error);
    showToast(/cancelled/i.test(message) ? "Preview cancelled." : message, !/cancelled/i.test(message));
    return undefined;
  }
  finally {
    cancelButton?.remove();
    for (const { control, disabled } of controls) {
      if (control.isConnected) control.disabled = disabled;
    }
    if (button?.isConnected) button.textContent = label ?? "Continue";
    delete state.uiOperation;
  }
}

function updateNav(): void {
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.route === state.route);
  });
  document.querySelector<HTMLElement>(".sidebar")?.classList.toggle("hidden", state.route === "welcome" || state.route === "setup");
  document.querySelector<HTMLElement>(".app-shell")?.style.setProperty("grid-template-columns", state.route === "welcome" || state.route === "setup" ? "1fr" : "230px minmax(0, 1fr)");
}

async function refreshBootstrap(): Promise<void> {
  state.bootstrap = await window.taskSync.getBootstrapState();
}

function route(next: Route): void {
  if (state.uiOperation) {
    showToast(`${state.uiOperation} is still running. Cancel it before leaving this page.`, true);
    return;
  }
  state.route = next;
  updateNav();
  void render();
}

async function render(): Promise<void> {
  if (!state.bootstrap) await refreshBootstrap();
  if (state.route === "welcome") renderWelcome();
  else if (state.route === "setup") renderSetup();
  else if (state.route === "dashboard") renderDashboard();
  else if (state.route === "plan") renderPlan();
  else if (state.route === "history") await renderHistory();
  else renderSettings();
  main.focus();
}

function renderWelcome(): void {
  main.innerHTML = `<section class="page welcome"><div class="card">
    <p class="eyebrow">Welcome to Task Sync</p>
    <h1>Turn school obligations into a plan you can trust.</h1>
    <p class="lede">Connect Canvas and Todoist, review every proposed change, then choose exactly when to apply it. Everything stays on this computer.</p>
    <div class="choice-grid">
      <div class="choice-card"><h2>Start fresh</h2><p class="muted">A guided setup takes you through Todoist, Canvas, and an optional OpenAI connection.</p><button class="button primary" id="start-fresh" data-testid="start-fresh">Begin setup</button></div>
      <div class="choice-card"><h2>Import CLI setup</h2><p class="muted">Copy an existing <code>.env</code>, config, database, or Google OAuth files. Originals will not be changed.</p><button class="button secondary" id="show-import">Choose files</button></div>
    </div>
    <div id="import-panel" class="form-section hidden"><h2>Import existing setup</h2><div class="path-list">${importRows()}</div><div class="button-row"><button class="button primary" id="run-import">Import selected files</button></div></div>
    <div class="security-note"><span>🔒</span><span>Credentials are stored in a local settings file and are never sent to the renderer after saving. Imported files are copied; existing desktop files are backed up first.</span></div>
  </div></section>`;
  main.querySelector("#start-fresh")?.addEventListener("click", () => { state.setupStep = 0; route("setup"); });
  main.querySelector("#show-import")?.addEventListener("click", () => main.querySelector("#import-panel")?.classList.remove("hidden"));
  main.querySelectorAll<HTMLButtonElement>("[data-file-kind]").forEach((button) => button.addEventListener("click", async () => {
    const kind = button.dataset.fileKind as Parameters<typeof window.taskSync.chooseFile>[0];
    const path = await window.taskSync.chooseFile(kind);
    if (!path) return;
    const key = button.dataset.requestKey as keyof ImportRequest;
    state.importRequest[key] = path;
    renderWelcome();
    main.querySelector("#import-panel")?.classList.remove("hidden");
  }));
  main.querySelector<HTMLButtonElement>("#run-import")?.addEventListener("click", async (event) => {
    const result = await runBusy(event.currentTarget as HTMLButtonElement, () => window.taskSync.importExistingSetup(state.importRequest));
    if (!result) return;
    await refreshBootstrap();
    showToast(`Imported ${result.imported.join(", ")}.`);
    if (state.bootstrap?.setupComplete) route("dashboard"); else { state.setupStep = 0; route("setup"); }
  });
}

function importRows(): string {
  const rows: Array<[string, Parameters<typeof window.taskSync.chooseFile>[0], keyof ImportRequest]> = [
    ["Environment", "env", "envFile"], ["Configuration", "config", "configFile"], ["SQLite database", "database", "databaseFile"],
    ["Google client", "google-client", "googleClientFile"], ["Google token", "google-token", "googleTokenFile"],
  ];
  return rows.map(([label, kind, key]) => `<div class="path-row"><strong>${label}</strong><span class="path-value">${escapeHtml(state.importRequest[key] || "Not selected")}</span><button class="button secondary" data-file-kind="${kind}" data-request-key="${key}">Choose</button></div>`).join("");
}

function steps(): string {
  return `<div class="steps" aria-label="Setup progress">${Array.from({ length: 5 }, (_, index) => `<span class="step ${index < state.setupStep ? "done" : index === state.setupStep ? "current" : ""}"></span>`).join("")}</div>`;
}

function setupFrame(title: string, description: string, body: string): void {
  main.innerHTML = `<section class="setup-shell"><p class="eyebrow">Initial setup · Step ${state.setupStep + 1} of 5</p><h1>${title}</h1><p class="lede">${description}</p>${steps()}<div class="card">${body}</div></section>`;
}

function renderSetup(): void {
  if (state.setupStep === 0) renderTodoistSetup();
  else if (state.setupStep === 1) renderCanvasSetup();
  else if (state.setupStep === 2) renderOpenAISetup();
  else if (state.setupStep === 3) void renderMappingSetup();
  else renderReviewSetup();
}

function renderTodoistSetup(): void {
  setupFrame("Connect Todoist", "Task Sync needs Todoist to check for existing tasks and create approved changes.", `
    <div class="field"><label for="todoist-token">Todoist API token</label><input id="todoist-token" type="password" autocomplete="off" placeholder="Paste your token" data-testid="todoist-token"><p class="field-hint">Leave blank to preserve a token you already saved.</p></div>
    <div id="diagnostic"></div><div class="button-row"><button class="button primary" id="save-test" data-testid="todoist-save">Save and test connection</button>${state.bootstrap?.credentials.todoist ? '<button class="button secondary" id="next">Continue</button>' : ""}</div>`);
  main.querySelector<HTMLButtonElement>("#save-test")?.addEventListener("click", async (event) => {
    const token = main.querySelector<HTMLInputElement>("#todoist-token")!.value;
    const report = await runBusy(event.currentTarget as HTMLButtonElement, async () => {
      await window.taskSync.saveSetup({ credentials: { todoistApiToken: token } });
      return window.taskSync.diagnose("todoist");
    });
    if (!report) return;
    showDiagnostic(report.ok, report.checks.map((check) => check.detail).join(" · "));
    await refreshBootstrap();
    if (report.ok) window.setTimeout(() => { state.setupStep = 1; renderSetup(); }, 500);
  });
  main.querySelector("#next")?.addEventListener("click", () => { state.setupStep = 1; renderSetup(); });
}

function renderCanvasSetup(): void {
  setupFrame("Connect Canvas", "Use the same Canvas address you open for school, plus a personal access token from Canvas account settings.", `
    <div class="field"><label for="canvas-url">Canvas school URL</label><input id="canvas-url" type="url" placeholder="https://school.instructure.com" value="${escapeHtml(state.bootstrap?.credentials.canvas ? "" : "")}" data-testid="canvas-url"></div>
    <div class="field"><label for="canvas-token">Canvas access token</label><input id="canvas-token" type="password" autocomplete="off" placeholder="Paste your token" data-testid="canvas-token"><p class="field-hint">Blank fields preserve credentials already saved.</p></div>
    <div id="diagnostic"></div><div class="button-row"><button class="button secondary" id="back">Back</button><button class="button primary" id="save-test" data-testid="canvas-save">Save and test connection</button>${state.bootstrap?.credentials.canvas ? '<button class="button secondary" id="next">Continue</button>' : ""}</div>`);
  main.querySelector("#back")?.addEventListener("click", () => { state.setupStep = 0; renderSetup(); });
  main.querySelector<HTMLButtonElement>("#save-test")?.addEventListener("click", async (event) => {
    const baseUrl = main.querySelector<HTMLInputElement>("#canvas-url")!.value;
    const token = main.querySelector<HTMLInputElement>("#canvas-token")!.value;
    const report = await runBusy(event.currentTarget as HTMLButtonElement, async () => {
      await window.taskSync.saveSetup({ credentials: { canvasBaseUrl: baseUrl, canvasAccessToken: token } });
      return window.taskSync.diagnose("canvas");
    });
    if (!report) return;
    showDiagnostic(report.ok, report.checks.map((check) => check.detail).join(" · "));
    await refreshBootstrap();
    if (report.ok) window.setTimeout(() => { state.setupStep = 2; renderSetup(); }, 500);
  });
  main.querySelector("#next")?.addEventListener("click", () => { state.setupStep = 2; renderSetup(); });
}

function renderOpenAISetup(): void {
  setupFrame("Choose enrichment", "OpenAI can clean up titles and descriptions. It is optional—the deterministic fallback works without an API key.", `
    <div class="field"><label for="openai-token">OpenAI API key (optional)</label><input id="openai-token" type="password" autocomplete="off" placeholder="sk-…" data-testid="openai-token"></div>
    <div id="diagnostic"></div><div class="button-row"><button class="button secondary" id="back">Back</button><button class="button secondary" id="skip" data-testid="openai-skip">Use deterministic fallback</button><button class="button primary" id="save-test">Save and test OpenAI</button></div>`);
  main.querySelector("#back")?.addEventListener("click", () => { state.setupStep = 1; renderSetup(); });
  main.querySelector("#skip")?.addEventListener("click", async () => {
    const config = structuredClone(state.bootstrap!.config); config.enrichment.mode = "fallback";
    await window.taskSync.saveSetup({ config }); await refreshBootstrap(); state.setupStep = 3; renderSetup();
  });
  main.querySelector<HTMLButtonElement>("#save-test")?.addEventListener("click", async (event) => {
    const key = main.querySelector<HTMLInputElement>("#openai-token")!.value;
    const report = await runBusy(event.currentTarget as HTMLButtonElement, async () => {
      const config = structuredClone(state.bootstrap!.config); config.enrichment.mode = "fallback";
      await window.taskSync.saveSetup({ credentials: { openaiApiKey: key }, config });
      return window.taskSync.diagnose("openai");
    });
    if (!report) return;
    showDiagnostic(report.ok, report.checks.map((check) => check.detail).join(" · "));
    await refreshBootstrap(); if (report.ok) window.setTimeout(() => { state.setupStep = 3; renderSetup(); }, 500);
  });
}

async function renderMappingSetup(): Promise<void> {
  setupFrame("Map your courses", "Choose where each Canvas course should land. Leaving a course in Inbox is completely fine.", `<div class="loading-panel"><div class="spinner"></div><p>Discovering courses and destinations…</p></div>`);
  let discoveryStage = "Canvas courses";
  try {
    if (!state.coursesLoaded) {
      updateDiscoveryStatus("Discovering Canvas courses…");
      state.courses = await window.taskSync.discoverCanvasCourses();
      state.coursesLoaded = true;
    }
    if (!state.destinations) {
      discoveryStage = "Todoist destinations";
      updateDiscoveryStatus("Discovering Todoist projects and sections…");
      state.destinations = await window.taskSync.listTodoistDestinations();
    }
  } catch (error) {
    renderDiscoveryError(discoveryStage, errorMessage(error));
    return;
  }
  const projects = state.destinations?.projects ?? [];
  const sections = state.destinations?.sections ?? [];
  const choices: Array<{ label: string; projectId?: string; sectionId?: string }> = [
    { label: "Todoist Inbox" },
    ...projects.map((project) => ({ label: project.name, projectId: project.id })),
    ...sections.map((section) => ({ label: `${projects.find((project) => project.id === section.projectId)?.name ?? "Project"} › ${section.name}`, projectId: section.projectId, sectionId: section.id })),
  ];
  const rows = state.courses.map((course) => {
    const mapping = state.bootstrap!.config.courseMappings.find((value) => value.sourceType === "canvas" && value.courseExternalId === course.externalId);
    const destination = mapping ? state.bootstrap!.config.destinations[mapping.destinationKey] : undefined;
    const selected = destination ? choices.findIndex((choice) => choice.projectId === destination.projectId && choice.sectionId === destination.sectionId) : 0;
    return `<div class="mapping-row"><div><strong>${escapeHtml(course.name)}</strong><div class="muted">Canvas course ${escapeHtml(course.externalId)}</div></div><select data-course-id="${escapeHtml(course.externalId)}" data-course-name="${escapeHtml(course.name)}">${choices.map((choice, index) => `<option value="${index}" ${index === Math.max(0, selected) ? "selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}</select></div>`;
  }).join("");
  main.querySelector(".card")!.innerHTML = `${rows || '<div class="empty"><div class="empty-icon">✓</div><p>No active Canvas courses were returned.</p></div>'}<div class="button-row"><button class="button secondary" id="back">Back</button><button class="button primary" id="save-mappings" data-testid="mapping-continue">Save mappings and continue</button></div>`;
  main.querySelector("#back")?.addEventListener("click", () => { state.setupStep = 2; renderSetup(); });
  main.querySelector<HTMLButtonElement>("#save-mappings")?.addEventListener("click", async (event) => {
    const config = structuredClone(state.bootstrap!.config);
    const destinations: AppConfig["destinations"] = { inbox: {} };
    const mappings: AppConfig["courseMappings"] = [];
    main.querySelectorAll<HTMLSelectElement>("[data-course-id]").forEach((select) => {
      const choice = choices[Number(select.value)] ?? choices[0]!;
      const projectId = choice.projectId;
      const sectionId = choice.sectionId;
      const key = sectionId ? `section_${sectionId.replace(/[^a-zA-Z0-9_-]/g, "_")}` : projectId ? `project_${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "inbox";
      if (projectId) destinations[key] = { projectId, ...(sectionId ? { sectionId } : {}) };
      mappings.push({ sourceType: "canvas", connectionId: config.sources.canvas.connectionId, courseExternalId: select.dataset.courseId!, destinationKey: key });
    });
    config.destinations = destinations; config.courseMappings = mappings; config.defaultDestinationKey = "inbox";
    const saved = await runBusy(event.currentTarget as HTMLButtonElement, () => window.taskSync.saveSetup({ config }));
    if (!saved) return; state.bootstrap = { ...state.bootstrap!, ...saved }; state.setupStep = 4; renderSetup();
  });
}

function updateDiscoveryStatus(message: string): void {
  const status = main.querySelector<HTMLElement>(".loading-panel p");
  if (status) status.textContent = message;
}

function renderDiscoveryError(stage: string, message: string): void {
  const card = main.querySelector<HTMLElement>(".card");
  if (!card) return;
  card.innerHTML = `<div class="empty"><div class="empty-icon">!</div><h2>Could not discover ${escapeHtml(stage)}</h2><p class="muted">${escapeHtml(message)}</p></div><div class="button-row"><button class="button secondary" id="back">Back</button><button class="button primary" id="retry-discovery">Try again</button></div>`;
  card.querySelector("#back")?.addEventListener("click", () => { state.setupStep = 2; renderSetup(); });
  card.querySelector("#retry-discovery")?.addEventListener("click", () => { void renderMappingSetup(); });
}

function renderReviewSetup(): void {
  const configured = state.bootstrap!.credentials;
  setupFrame("Ready for your first preview", "Nothing has been written to Todoist yet. Preview builds a reviewable plan and safely checks for duplicates.", `
    <div class="provider-row"><div><strong>Todoist</strong><div class="muted">Required destination</div></div><span class="badge ${configured.todoist ? "ok" : "error"}">${configured.todoist ? "Connected" : "Missing"}</span></div>
    <div class="provider-row"><div><strong>Canvas</strong><div class="muted">Primary source</div></div><span class="badge ${configured.canvas ? "ok" : "error"}">${configured.canvas ? "Connected" : "Missing"}</span></div>
    <div class="provider-row"><div><strong>OpenAI</strong><div class="muted">Optional enrichment</div></div><span class="badge neutral">${configured.openai ? "Configured" : "Fallback"}</span></div>
    <div class="button-row"><button class="button secondary" id="back">Back</button><button class="button primary large" id="first-preview" data-testid="first-preview">Preview Canvas sync</button></div>`);
  main.querySelector("#back")?.addEventListener("click", () => { state.setupStep = 3; renderSetup(); });
  main.querySelector<HTMLButtonElement>("#first-preview")?.addEventListener("click", (event) => void preview(event.currentTarget as HTMLButtonElement));
}

function showDiagnostic(ok: boolean, message: string): void {
  const element = main.querySelector<HTMLElement>("#diagnostic");
  if (element) { element.className = `diagnostic ${ok ? "ok" : "error"}`; element.textContent = message; }
}

function renderDashboard(): void {
  const bootstrap = state.bootstrap!;
  const providers: Provider[] = ["todoist", "canvas", "openai", "classroom"];
  const warnings = bootstrap.lastRun?.summary.warning ?? 0;
  main.innerHTML = `<section class="page"><div class="page-header"><div><p class="eyebrow">Dashboard</p><h1>Your sync workspace</h1><p class="lede">Preview what Canvas would change in Todoist. You stay in control of every write.</p></div><button class="button secondary" id="refresh">Refresh status</button></div>
    <div class="grid three"><div class="card metric"><div class="metric-top"><span>Last activity</span><span>↻</span></div><strong>${bootstrap.lastRun ? escapeHtml(bootstrap.lastRun.mode) : "No runs"}</strong><span class="muted">${friendlyDate(bootstrap.lastRun?.startedAt)}</span></div><div class="card metric"><div class="metric-top"><span>Warnings</span><span>!</span></div><strong>${warnings}</strong><span class="muted">From the latest run</span></div><div class="card metric"><div class="metric-top"><span>Mode</span><span>◇</span></div><strong>${escapeHtml(bootstrap.config.enrichment.mode)}</strong><span class="muted">Enrichment behavior</span></div></div>
    <div class="hero-action"><div><h2>Preview Canvas Sync</h2><p>Build a plan first. Todoist will not be changed during preview.</p></div><button class="button large" id="preview" data-testid="dashboard-preview">Preview now</button></div>
    <div class="card"><h2>Connections</h2><p class="muted">Credentials remain write-only in the desktop application.</p>${providers.map((provider) => `<div class="provider-row"><div class="provider-name"><span class="provider-icon">${providerNames[provider].slice(0, 1)}</span><div><strong>${providerNames[provider]}</strong><div class="muted">${provider === "classroom" ? "Optional · Advanced" : provider === "openai" ? "Optional" : "Required"}</div></div></div><span class="badge ${bootstrap.credentials[provider] ? "ok" : provider === "openai" || provider === "classroom" ? "neutral" : "error"}">${bootstrap.credentials[provider] ? "Configured" : provider === "openai" || provider === "classroom" ? "Optional" : "Needs setup"}</span></div>`).join("")}</div>
  </section>`;
  main.querySelector<HTMLButtonElement>("#preview")?.addEventListener("click", (event) => void preview(event.currentTarget as HTMLButtonElement));
  main.querySelector("#refresh")?.addEventListener("click", async () => { await refreshBootstrap(); renderDashboard(); showToast("Status refreshed."); });
}

async function preview(button: HTMLButtonElement, source: "canvas" | "classroom" | "all" = "canvas"): Promise<void> {
  const plan = await runBusy(
    button,
    () => window.taskSync.createPlan({ source, forceReenrich: false }),
    { name: "Preview", cancellable: true },
  );
  if (!plan) return;
  state.plan = plan; state.planFilter = "all"; await refreshBootstrap(); route("plan");
}

function renderPlan(): void {
  if (!state.plan) { route("dashboard"); return; }
  const kinds: SyncActionKind[] = ["create", "update", "unchanged", "skip", "conflict", "error"];
  const actions = state.plan.plan.actions.filter((action) => state.planFilter === "all" || action.kind === state.planFilter);
  const excluded = (state.plan.counts.conflict ?? 0) + (state.plan.counts.error ?? 0);
  main.innerHTML = `<section class="page"><div class="page-header"><div><p class="eyebrow">Plan review</p><h1>Review before applying</h1><p class="lede">This exact plan expires ${friendlyDate(state.plan.expiresAt)}. Conflict and error rows are never written.</p></div><button class="button secondary" id="back-dashboard">Back to dashboard</button></div>
    <div class="summary-strip">${kinds.map((kind) => `<div class="summary-cell"><strong>${state.plan!.counts[kind] ?? 0}</strong><span>${kind}</span></div>`).join("")}</div>
    ${excluded ? `<div class="callout"><strong>${excluded} excluded ${excluded === 1 ? "row" : "rows"}.</strong> Conflicts and errors will remain unwritten while safe create/update actions continue.</div>` : ""}
    <div class="filter-row"><button class="filter-button ${state.planFilter === "all" ? "active" : ""}" data-filter="all">All ${state.plan.plan.actions.length}</button>${kinds.map((kind) => `<button class="filter-button ${state.planFilter === kind ? "active" : ""}" data-filter="${kind}">${kind} ${state.plan!.counts[kind] ?? 0}</button>`).join("")}</div>
    <div class="plan-list">${actions.length ? actions.map(renderPlanAction).join("") : '<div class="card empty"><div class="empty-icon">○</div><p>No rows match this filter.</p></div>'}</div>
    <div class="button-row"><button class="button primary large" id="apply-plan" data-testid="apply-plan" data-plan-id="${state.plan.plan.id}" data-plan-digest="${state.plan.digest}" ${state.plan.canApply ? "" : "disabled"}>Apply safe changes</button><span class="muted">${state.plan.canApply ? "Only create and update actions will be written." : "There are no changes to apply."}</span></div>
  </section>`;
  main.querySelector("#back-dashboard")?.addEventListener("click", () => route("dashboard"));
  main.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => button.addEventListener("click", () => { state.planFilter = button.dataset.filter as typeof state.planFilter; renderPlan(); }));
  main.querySelectorAll<HTMLButtonElement>("[data-source-url]").forEach((button) => button.addEventListener("click", () => void window.taskSync.openExternal(button.dataset.sourceUrl!)));
  main.querySelector<HTMLButtonElement>("#apply-plan")?.addEventListener("click", async (event) => {
    if (!window.confirm(`Apply ${(state.plan!.counts.create ?? 0) + (state.plan!.counts.update ?? 0)} safe changes? ${excluded} conflict/error rows will be excluded.`)) return;
    const result = await runBusy(event.currentTarget as HTMLButtonElement, () => window.taskSync.applyPlan({ planId: state.plan!.plan.id, digest: state.plan!.digest }));
    if (!result) return;
    const successful = result.outcomes.filter((outcome) => outcome.outcome === "create" || outcome.outcome === "update").length;
    showToast(`Apply finished: ${successful} safe changes processed.`); delete state.plan; await refreshBootstrap(); route("history");
  });
}

function renderPlanAction(action: PlanView["plan"]["actions"][number]): string {
  const candidate = action.candidate;
  const title = candidate?.resolvedTitle ?? action.sourceKey;
  return `<details class="plan-item" data-kind="${action.kind}"><summary><span class="badge ${action.kind}">${action.kind}</span><span class="plan-title">${escapeHtml(title)}</span><span aria-hidden="true">⌄</span></summary><div class="plan-detail">
    <div><strong>Destination</strong>${escapeHtml(candidate?.destinationKey ?? "Not resolved")}</div><div><strong>Deadline</strong>${escapeHtml(candidate?.resolvedDeadlineAt ? friendlyDate(candidate.resolvedDeadlineAt) : "None")} · ${escapeHtml(candidate?.deadlineOrigin ?? "none")}</div>
    <div><strong>Reason</strong>${escapeHtml(action.reason)}</div><div><strong>Warnings</strong>${escapeHtml(candidate?.warnings.join(" · ") || "None")}</div>
    ${candidate?.source.sourceUrl ? `<div><strong>Source</strong><button class="button secondary" data-source-url="${escapeHtml(candidate.source.sourceUrl)}">Open source page</button></div>` : ""}
  </div></details>`;
}

async function renderHistory(): Promise<void> {
  main.innerHTML = `<section class="page"><div class="page-header"><div><p class="eyebrow">Recent history</p><h1>The last 20 runs</h1><p class="lede">Preview and apply outcomes recorded in the local database.</p></div></div><div class="card"><div class="loading-panel"><div class="spinner"></div></div></div></section>`;
  const runs = await runBusy(null, () => window.taskSync.listRecentRuns(20));
  if (!runs) return;
  const container = main.querySelector(".card")!;
  container.innerHTML = runs.length ? runs.map(runRow).join("") : '<div class="empty"><div class="empty-icon">↻</div><h2>No history yet</h2><p>Your first preview will appear here.</p></div>';
  container.querySelectorAll<HTMLButtonElement>("[data-run-id]").forEach((button) => button.addEventListener("click", async () => {
    const detail = await runBusy(button, () => window.taskSync.getRun(button.dataset.runId!));
    if (!detail) return;
    const details = document.querySelector<HTMLElement>(`#detail-${CSS.escape(detail.id)}`)!;
    details.innerHTML = detail.outcomes.length ? detail.outcomes.map((outcome) => `<div class="provider-row"><div><strong>${escapeHtml(outcome.sourceKey)}</strong><div class="muted">${escapeHtml(outcome.detail)}</div></div><span class="badge ${escapeHtml(outcome.outcome)}">${escapeHtml(outcome.outcome)}</span></div>`).join("") : '<p class="muted">No per-item outcomes were recorded.</p>';
    details.classList.remove("hidden");
  }));
}

function runRow(run: RunSummary): string {
  const total = (["create", "update", "unchanged", "skip", "conflict", "error"] as const).reduce((sum, kind) => sum + (run.summary[kind] ?? 0), 0);
  return `<div class="run-row"><div><strong>${escapeHtml(run.mode === "plan" ? "Preview" : "Apply")} · ${total} items</strong><div class="muted">${friendlyDate(run.startedAt)} · ${escapeHtml(run.origin)}</div><div id="detail-${escapeHtml(run.id)}" class="form-section hidden"></div></div><button class="button secondary" data-run-id="${escapeHtml(run.id)}">View details</button></div>`;
}

function renderSettings(): void {
  const bootstrap = state.bootstrap!;
  const config = bootstrap.config;
  main.innerHTML = `<section class="page"><div class="page-header"><div><p class="eyebrow">Settings</p><h1>Connections and behavior</h1><p class="lede">Blank credential fields preserve what is already saved. Removing a credential is always a separate action.</p></div></div>
    <div class="card"><h2>Credentials</h2>${(["todoist", "canvas", "openai"] as Provider[]).map((provider) => `<div class="provider-row"><div><strong>${providerNames[provider]}</strong><div class="muted">${bootstrap.credentials[provider] ? "Configured locally" : "Not configured"}</div></div><div class="button-row"><button class="button secondary" data-edit-provider="${provider}">Edit</button>${bootstrap.credentials[provider] ? `<button class="button danger" data-remove-provider="${provider}">Remove</button>` : ""}</div></div>`).join("")}</div>
    <div class="card"><h2>Enrichment and sync</h2><div class="grid two"><div class="field"><label for="mode">Enrichment mode</label><select id="mode"><option value="fallback" ${config.enrichment.mode === "fallback" ? "selected" : ""}>Fallback if OpenAI is unavailable</option><option value="required" ${config.enrichment.mode === "required" ? "selected" : ""}>Require OpenAI</option><option value="disabled" ${config.enrichment.mode === "disabled" ? "selected" : ""}>Deterministic only</option></select></div><div class="field"><label for="model">OpenAI model</label><input id="model" value="${escapeHtml(config.enrichment.model)}"></div><div class="field"><label for="due-confidence">Inferred due-date confidence</label><input id="due-confidence" type="number" min="0" max="1" step="0.01" value="${config.enrichment.inferredDueConfidence}"></div><div class="field"><label for="mapping-confidence">Mapping confidence</label><input id="mapping-confidence" type="number" min="0" max="1" step="0.01" value="${config.enrichment.mappingConfidence}"></div></div><div class="field"><label for="labels">Allowed labels (comma separated)</label><input id="labels" value="${escapeHtml(config.enrichment.allowedLabels.join(", "))}"></div><div class="field"><label for="completed">Completed source items</label><select id="completed"><option value="skip" ${config.sync.completedSourceItems === "skip" ? "selected" : ""}>Skip</option><option value="include" ${config.sync.completedSourceItems === "include" ? "selected" : ""}>Include</option></select></div><button class="button primary" id="save-settings">Save behavior</button></div>
    <div class="card"><h2>Course mappings</h2><p class="muted">Rediscover Canvas courses and map them to Todoist projects or sections.</p><button class="button secondary" id="remap-courses">Edit course mappings</button></div>
    <div class="card"><h2>Advanced · Google Classroom</h2><p class="muted">Optional. Canvas works without Classroom. Choose the Desktop OAuth client JSON, then authorize in your browser.</p><div class="provider-row"><div><strong>Google Classroom</strong><div class="muted">${bootstrap.credentials.classroom ? "Authorized" : "Not enabled"}</div></div><div class="button-row"><button class="button secondary" id="choose-google">Choose OAuth JSON</button><button class="button primary" id="authorize-google">Authorize Google</button>${bootstrap.credentials.classroom ? '<button class="button secondary" id="preview-classroom">Preview Classroom</button><button class="button secondary" id="preview-all">Preview Canvas + Classroom</button><button class="button danger" data-remove-provider="classroom">Remove</button>' : ""}</div></div><div id="google-path" class="muted"></div></div>
    <div class="card"><h2>Desktop data</h2><div class="muted">Configuration: ${escapeHtml(bootstrap.paths.config)}<br>Database: ${escapeHtml(bootstrap.paths.database)}<br>Secrets: ${escapeHtml(bootstrap.paths.secrets)}</div></div>
  </section>`;
  main.querySelectorAll<HTMLButtonElement>("[data-edit-provider]").forEach((button) => button.addEventListener("click", () => { const provider = button.dataset.editProvider; state.setupStep = provider === "todoist" ? 0 : provider === "canvas" ? 1 : 2; route("setup"); }));
  main.querySelector("#remap-courses")?.addEventListener("click", () => { state.courses = []; state.coursesLoaded = false; delete state.destinations; state.setupStep = 3; route("setup"); });
  main.querySelectorAll<HTMLButtonElement>("[data-remove-provider]").forEach((button) => button.addEventListener("click", async () => {
    const provider = button.dataset.removeProvider as Provider;
    if (!window.confirm(`Remove the saved ${providerNames[provider]} credential?`)) return;
    state.bootstrap = { ...state.bootstrap!, ...await window.taskSync.removeCredential(provider) }; renderSettings(); showToast(`${providerNames[provider]} removed.`);
  }));
  main.querySelector<HTMLButtonElement>("#save-settings")?.addEventListener("click", async (event) => {
    const next = structuredClone(config);
    next.enrichment.mode = main.querySelector<HTMLSelectElement>("#mode")!.value as AppConfig["enrichment"]["mode"];
    next.enrichment.model = main.querySelector<HTMLInputElement>("#model")!.value;
    next.enrichment.inferredDueConfidence = Number(main.querySelector<HTMLInputElement>("#due-confidence")!.value);
    next.enrichment.mappingConfidence = Number(main.querySelector<HTMLInputElement>("#mapping-confidence")!.value);
    next.enrichment.allowedLabels = main.querySelector<HTMLInputElement>("#labels")!.value.split(",").map((label) => label.trim()).filter(Boolean);
    next.sync.completedSourceItems = main.querySelector<HTMLSelectElement>("#completed")!.value as "skip" | "include";
    const saved = await runBusy(event.currentTarget as HTMLButtonElement, () => window.taskSync.saveSetup({ config: next }));
    if (saved) { state.bootstrap = { ...state.bootstrap!, ...saved }; showToast("Settings saved."); }
  });
  let googleClientFile: string | undefined;
  main.querySelector("#choose-google")?.addEventListener("click", async () => {
    googleClientFile = await window.taskSync.chooseFile("google-client");
    const label = main.querySelector<HTMLElement>("#google-path")!; label.textContent = googleClientFile ?? "No file selected";
    if (googleClientFile) { await window.taskSync.importExistingSetup({ googleClientFile }); showToast("OAuth client copied. You can authorize now."); }
  });
  main.querySelector<HTMLButtonElement>("#authorize-google")?.addEventListener("click", async (event) => {
    const saved = await runBusy(event.currentTarget as HTMLButtonElement, () => window.taskSync.authorizeClassroom());
    if (saved) { state.bootstrap = { ...state.bootstrap!, ...saved }; showToast("Google Classroom authorized."); renderSettings(); }
  });
  main.querySelector<HTMLButtonElement>("#preview-classroom")?.addEventListener("click", (event) => void preview(event.currentTarget as HTMLButtonElement, "classroom"));
  main.querySelector<HTMLButtonElement>("#preview-all")?.addEventListener("click", (event) => void preview(event.currentTarget as HTMLButtonElement, "all"));
}

document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((button) => button.addEventListener("click", () => route(button.dataset.route as Route)));

void (async () => {
  try {
    await refreshBootstrap();
    state.route = state.bootstrap!.setupComplete ? "dashboard" : "welcome";
    updateNav(); await render();
  } catch (error) {
    main.innerHTML = `<section class="page"><div class="card"><h1>Task Sync could not start</h1><p class="lede">${escapeHtml(errorMessage(error))}</p></div></section>`;
  }
})();
