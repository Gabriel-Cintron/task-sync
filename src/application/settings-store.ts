import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { parse } from "dotenv";
import { AppConfigSchema, loadConfig, saveConfig, type AppConfig } from "../config.js";
import { AppPathsSchema, ImportRequestSchema, SetupInputSchema, type AppPaths, type CredentialStatus, type ImportRequest, type ImportResult, type SetupInput, type SetupStatus } from "./contracts.js";

const ENV_KEYS = {
  todoistApiToken: "TODOIST_API_TOKEN",
  canvasBaseUrl: "CANVAS_BASE_URL",
  canvasAccessToken: "CANVAS_ACCESS_TOKEN",
  openaiApiKey: "OPENAI_API_KEY",
  googleClientSecretFile: "GOOGLE_CLIENT_SECRET_FILE",
  googleTokenFile: "GOOGLE_TOKEN_FILE",
} as const;

function quoteEnv(value: string): string {
  return JSON.stringify(value);
}

type FileMutation = { destination: string; backup?: string };

function assertFile(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error(`Import file does not exist: ${path}`);
  return resolved;
}

function atomicCopy(source: string, destination: string, backups: string[], mutations: FileMutation[]): void {
  const resolved = resolve(source);
  assertFile(resolved);
  mkdirSync(dirname(destination), { recursive: true });
  let backup: string | undefined;
  if (existsSync(destination)) {
    backup = `${destination}.${Date.now()}.bak`;
    copyFileSync(destination, backup);
    backups.push(backup);
  }
  const temporary = `${destination}.${process.pid}.tmp`;
  copyFileSync(resolved, temporary);
  renameSync(temporary, destination);
  mutations.push({ destination, ...(backup ? { backup } : {}) });
}

function rollback(mutations: FileMutation[]): void {
  for (const mutation of [...mutations].reverse()) {
    if (mutation.backup) copyFileSync(mutation.backup, mutation.destination);
    else if (existsSync(mutation.destination)) unlinkSync(mutation.destination);
  }
}

export class SettingsStore {
  public readonly paths: AppPaths;

  public constructor(paths: AppPaths) {
    this.paths = AppPathsSchema.parse(paths);
    mkdirSync(this.paths.root, { recursive: true });
    mkdirSync(dirname(this.paths.database), { recursive: true });
    mkdirSync(this.paths.secrets, { recursive: true });
  }

  public environment(): Record<string, string | undefined> {
    return { ...process.env, ...this.fileEnvironment() };
  }

  public config(): AppConfig {
    const parsed = loadConfig(this.paths.config);
    return AppConfigSchema.parse({ ...parsed, databasePath: this.paths.database });
  }

  public status(): SetupStatus {
    const env = this.environment();
    return {
      credentials: this.credentialStatus(env),
      config: this.config(),
      paths: this.paths,
    };
  }

  public save(input: SetupInput): SetupStatus {
    const parsed = SetupInputSchema.parse(input);
    if (parsed.credentials) {
      const env = this.fileEnvironment();
      for (const [field, envKey] of Object.entries(ENV_KEYS) as Array<[keyof typeof ENV_KEYS, string]>) {
        const value = parsed.credentials[field];
        if (value?.trim()) env[envKey] = value.trim();
      }
      this.writeEnvironment(env);
    }
    if (parsed.config) saveConfig(this.paths.config, { ...parsed.config, databasePath: this.paths.database });
    else if (!existsSync(this.paths.config)) saveConfig(this.paths.config, this.config());
    return this.status();
  }

  public removeCredential(provider: "todoist" | "canvas" | "openai" | "classroom"): SetupStatus {
    const env = this.fileEnvironment();
    const keys = provider === "todoist" ? ["TODOIST_API_TOKEN"]
      : provider === "canvas" ? ["CANVAS_BASE_URL", "CANVAS_ACCESS_TOKEN"]
        : provider === "openai" ? ["OPENAI_API_KEY"]
          : ["GOOGLE_CLIENT_SECRET_FILE", "GOOGLE_TOKEN_FILE"];
    for (const key of keys) delete env[key];
    this.writeEnvironment(env);
    return this.status();
  }

  public importExisting(request: ImportRequest): ImportResult {
    const parsed = ImportRequestSchema.parse(request);
    const imported: string[] = [];
    const backups: string[] = [];
    const mutations: FileMutation[] = [];

    // Validate every selected input before changing desktop-owned state.
    const importedEnvironment = parsed.envFile ? parse(readFileSync(assertFile(parsed.envFile))) : undefined;
    if (parsed.configFile) AppConfigSchema.parse(JSON.parse(readFileSync(assertFile(parsed.configFile), "utf8")) as unknown);
    if (parsed.databaseFile) {
      assertFile(parsed.databaseFile);
      if (![".sqlite", ".db"].includes(extname(parsed.databaseFile).toLowerCase())) throw new Error("Imported database must be a .sqlite or .db file");
      const header = readFileSync(resolve(parsed.databaseFile)).subarray(0, 16).toString("utf8");
      if (header !== "SQLite format 3\u0000") throw new Error("Imported database is not a valid SQLite file");
    }
    if (parsed.googleClientFile) {
      const google = JSON.parse(readFileSync(assertFile(parsed.googleClientFile), "utf8")) as { installed?: unknown };
      if (!google.installed || typeof google.installed !== "object") throw new Error("Google OAuth JSON must contain an installed desktop client");
    }
    if (parsed.googleTokenFile) JSON.parse(readFileSync(assertFile(parsed.googleTokenFile), "utf8")) as unknown;

    try {
      if (parsed.configFile) {
        atomicCopy(parsed.configFile, this.paths.config, backups, mutations);
        imported.push("configuration");
      }
      if (parsed.databaseFile) {
        atomicCopy(parsed.databaseFile, this.paths.database, backups, mutations);
        imported.push("database");
      }
      const environment = { ...this.fileEnvironment(), ...importedEnvironment };
      if (parsed.googleClientFile) {
        const destination = join(this.paths.secrets, "google-oauth-client.json");
        atomicCopy(parsed.googleClientFile, destination, backups, mutations);
        chmodSync(destination, 0o600);
        environment.GOOGLE_CLIENT_SECRET_FILE = destination;
        environment.GOOGLE_TOKEN_FILE = join(this.paths.secrets, "google-oauth-token.json");
        imported.push("google-client");
      }
      if (parsed.googleTokenFile) {
        const destination = join(this.paths.secrets, "google-oauth-token.json");
        atomicCopy(parsed.googleTokenFile, destination, backups, mutations);
        chmodSync(destination, 0o600);
        environment.GOOGLE_TOKEN_FILE = destination;
        imported.push("google-token");
      }
      if (parsed.envFile || parsed.googleClientFile || parsed.googleTokenFile) {
        this.writeEnvironment(environment, backups, mutations);
        if (parsed.envFile) imported.unshift("environment");
      }
      return { imported, backups };
    } catch (error) {
      rollback(mutations);
      throw error;
    }
  }

  private credentialStatus(env: Record<string, string | undefined>): CredentialStatus {
    return {
      todoist: Boolean(env.TODOIST_API_TOKEN),
      canvas: Boolean(env.CANVAS_BASE_URL && env.CANVAS_ACCESS_TOKEN),
      openai: Boolean(env.OPENAI_API_KEY),
      classroom: Boolean(env.GOOGLE_CLIENT_SECRET_FILE && env.GOOGLE_TOKEN_FILE && existsSync(env.GOOGLE_TOKEN_FILE)),
    };
  }

  private fileEnvironment(): Record<string, string | undefined> {
    return existsSync(this.paths.env) ? parse(readFileSync(this.paths.env)) : {};
  }

  private writeEnvironment(values: Record<string, string | undefined>, backups: string[] = [], mutations?: FileMutation[]): void {
    const managed = new Set<string>(Object.values(ENV_KEYS));
    const lines = Object.keys(values)
      .filter((key) => managed.has(key) && values[key])
      .sort()
      .map((key) => `${key}=${quoteEnv(values[key]!)}`);
    mkdirSync(dirname(this.paths.env), { recursive: true });
    let backup: string | undefined;
    if (mutations && existsSync(this.paths.env)) {
      backup = `${this.paths.env}.${Date.now()}.bak`;
      copyFileSync(this.paths.env, backup);
      backups.push(backup);
    }
    const temporary = `${this.paths.env}.${process.pid}.tmp`;
    writeFileSync(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.paths.env);
    chmodSync(this.paths.env, 0o600);
    if (mutations) mutations.push({ destination: this.paths.env, ...(backup ? { backup } : {}) });
  }
}

export function desktopPaths(root: string): AppPaths {
  const resolved = resolve(root);
  return {
    root: resolved,
    env: join(resolved, "settings.env"),
    config: join(resolved, "task-sync.config.json"),
    database: join(resolved, "data", "task-sync.sqlite"),
    secrets: join(resolved, "secrets"),
  };
}
