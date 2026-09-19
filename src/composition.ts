import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { CanvasAdapter } from "./adapters/canvas.js";
import { GoogleClassroomAdapter } from "./adapters/google-classroom.js";
import { TodoistAdapter } from "./adapters/todoist.js";
import type { SourceAdapter } from "./core/ports.js";

export function createTodoistFromEnvironment(): TodoistAdapter {
  const token = process.env.TODOIST_API_TOKEN;
  if (!token) throw new Error("TODOIST_API_TOKEN is required");
  return new TodoistAdapter(token);
}

export function createClassroomFromEnvironment(config: AppConfig): GoogleClassroomAdapter {
  const clientFile = process.env.GOOGLE_CLIENT_SECRET_FILE;
  const tokenFile = process.env.GOOGLE_TOKEN_FILE;
  if (!clientFile || !tokenFile) throw new Error("GOOGLE_CLIENT_SECRET_FILE and GOOGLE_TOKEN_FILE are required");
  return new GoogleClassroomAdapter(
    config.sources.googleClassroom.connectionId,
    resolve(clientFile),
    resolve(tokenFile),
  );
}

export function createSources(config: AppConfig, selection: "canvas" | "classroom" | "all"): SourceAdapter[] {
  const sources: SourceAdapter[] = [];
  if (selection === "canvas" || selection === "all") {
    const baseUrl = process.env.CANVAS_BASE_URL;
    const token = process.env.CANVAS_ACCESS_TOKEN;
    if (baseUrl && token) sources.push(new CanvasAdapter(config.sources.canvas.connectionId, baseUrl, token));
    else if (selection === "canvas") throw new Error("CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN are required");
  }
  if (selection === "classroom" || selection === "all") {
    try {
      sources.push(createClassroomFromEnvironment(config));
    } catch (error) {
      if (selection === "classroom") throw error;
    }
  }
  if (sources.length === 0) throw new Error("No configured source adapters matched the selection");
  return sources;
}
